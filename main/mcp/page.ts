export type BrowserPageAction = "click" | "scroll" | "type" | "select" | "check";

export interface BrowserPageOptions {
  pixels?: number;
  text?: string;
  option?: string;
  checked?: boolean;
}

// Serialized into Electron's isolated world. Keep both functions self-contained.
// Prefers attributes that survive layout changes: a unique id, data-testid, name or aria-label, on the
// element or its nearest ancestor with one. Falls back to positions below that ancestor.
export function pageSelector(target: Element): string {
  const unique = (selector: string) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const anchor = (node: Element) => {
    const tag = CSS.escape(node.localName);
    const candidates = [
      node.id && "#" + CSS.escape(node.id),
      ...["data-testid", "data-test", "data-cy", "name", "aria-label"].map(attribute => {
        const value = node.getAttribute(attribute);
        return value ? `${tag}[${attribute}="${CSS.escape(value)}"]` : "";
      }),
    ];
    return candidates.find(candidate => candidate && unique(candidate));
  };

  const segments: string[] = [];
  for (let node: Element | null = target; node; node = node.parentElement) {
    const found = anchor(node);
    if (found) {
      segments.unshift(found);
      break;
    }

    const tag = CSS.escape(node.localName);
    let position = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === node.localName) position++;
    }
    segments.unshift(node.parentElement ? tag + ":nth-of-type(" + position + ")" : tag);
  }

  return segments.join(" > ");
}

// What runPageAction leaves to the main process: a trusted click at a point in CSS pixels of the
// viewport, or text input into the focused field, whose contents are selected so the input replaces them.
export type PageActionStep = string | { click: { x: number; y: number } } | { type: true };

// scope is the URL prefix the page must still be on: the origin plus "/" for a web tab, or the
// mock preview URL. The mock preview runs sandboxed with an opaque origin, so origins cannot be compared.
// Checks the element and prepares the action. Clicks and text input are left to the main process, which
// sends them as trusted input events, as a user's would be.
export function runPageAction(
  scope: string, action: BrowserPageAction, selector: string | undefined, options: BrowserPageOptions,
): PageActionStep {
  const { pixels, option, checked } = options;
  if (!window.location.href.startsWith(scope)) throw new Error("The tab left the page it was used for.");

  const visible = (element: Element) => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible";
  const describe = (element: Element) => element.localName + (element.id ? "#" + element.id : "") +
    Array.from(element.classList).slice(0, 2).map(name => "." + name).join("");

  if (action === "scroll" && selector === undefined) {
    window.scrollBy(0, pixels ?? 0);
    return "Scrolled the page.";
  }

  const element = document.querySelector(selector || "");
  if (!(element instanceof HTMLElement)) throw new Error("No visible element matches the selector.");
  // A checkbox or radio button styled through its label is often hidden itself.
  const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []).filter(visible) : [];
  if (!visible(element) && (action !== "check" || labels.length === 0)) throw new Error("No visible element matches the selector.");

  if (action === "scroll") {
    element.scrollBy(0, pixels ?? 0);
    return "Scrolled the element.";
  }

  if (element.matches(":disabled,[aria-disabled=true]")) throw new Error("The element is disabled.");
  // Smooth scrolling would move the element after its position is measured.
  const reveal = (target: Element, position: ScrollLogicalPosition) =>
    target.scrollIntoView({ block: position, inline: position, behavior: "instant" });
  reveal(element, "nearest");
  if (action === "type") {
    const textInput = element instanceof HTMLInputElement &&
      ["text", "search", "email", "tel", "url", "password", "number"].includes(element.type);
    const textArea = element instanceof HTMLTextAreaElement;
    if ((!textInput && !textArea && !element.isContentEditable) || element.matches("[readonly]")) {
      throw new Error("The element is not an editable text field.");
    }

    element.focus();
    if (textInput || textArea) {
      (element as HTMLInputElement | HTMLTextAreaElement).select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    if (document.activeElement !== element && !element.contains(document.activeElement)) {
      throw new Error("The element did not take focus.");
    }
    return { type: true };
  }

  if (action === "select") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("The element is not a select box.");

    const options = Array.from(element.options);
    const label = (item: HTMLOptionElement) => item.label.replace(/\s+/g, " ").trim();
    const target = options.find(item => item.value === option) ?? options.find(item => label(item) === option);
    if (!target) {
      const choices = options.slice(0, 30).map(item => JSON.stringify(label(item)) + (item.value !== label(item) ? ` (${JSON.stringify(item.value)})` : ""));
      throw new Error(`No option matches. Options: ${choices.join(", ")}${options.length > 30 ? ", ..." : ""}`);
    }
    if (target.disabled) throw new Error("The option is disabled.");

    // A select box opens a native popup on click, so the option is chosen as the page's own script would.
    element.focus();
    target.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return `Selected ${JSON.stringify(label(target))}.`;
  }

  if (action === "check") {
    if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) {
      throw new Error("The element is not a checkbox or radio button.");
    }
    if (element.checked === checked) return `The element is already ${checked ? "checked" : "unchecked"}.`;
    if (element.type === "radio" && !checked) throw new Error("A radio button cannot be unchecked. Check another one in the group.");
  }

  // A hidden tab has no viewport to click in, so the page's handlers run through a script click instead.
  if (window.innerWidth === 0 || window.innerHeight === 0) {
    element.click();
    if (action === "check" && (element as HTMLInputElement).checked !== checked) throw new Error("The page did not change the checked state.");
    const done = action === "check" ? (checked ? "Checked the element" : "Unchecked the element") : "Clicked the selected element";
    return `${done} with a script click, since the tab is not shown.`;
  }

  // Clicks the middle of the visible part of the element, or of a label of a checkbox, where it receives the click.
  // An element scrolled to the edge of the viewport can be under a fixed header, so the middle is tried next.
  let covering: Element | null = null;
  for (const [position, target] of (["nearest", "center"] as const).flatMap(position => [element, ...labels].map(target => [position, target] as const))) {
    if (!visible(target)) continue;

    reveal(target, position);
    const rect = target.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) continue;

    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (target.contains(hit) || labels.some(item => item.contains(hit)))) return { click: { x, y } };
    covering ??= hit;
  }
  if (covering) throw new Error(`Another element covers the element and would receive the click: ${describe(covering)}.`);
  throw new Error("The element is outside the visible area.");
}

// Serialized into Electron's isolated world. Returns the text of a field after input, or whether a
// checkbox or radio button is checked.
export function readPageField(selector: string) {
  const element = document.querySelector(selector);
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return element.checked;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  return element instanceof HTMLElement ? element.innerText : null;
}

// Serialized into Electron's isolated world. Returns whether the wait condition holds on the page in scope.
// With only selector, a visible matching element; with text, the text in that element or the page body;
// with neither, a fully loaded document. gone inverts the result.
export function checkPageCondition(scope: string, selector: string | undefined, text: string | undefined, gone: boolean) {
  if (!window.location.href.startsWith(scope)) return false;

  let found: boolean;
  if (selector !== undefined) {
    const element = document.querySelector(selector);
    found = element instanceof HTMLElement && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible" && (text === undefined || element.innerText.includes(text));
  } else if (text !== undefined) {
    found = (document.body?.innerText ?? "").includes(text);
  } else {
    found = document.readyState === "complete";
  }
  return gone ? !found : found;
}

// Serialized into Electron's isolated world. Scrolls the element into view and returns its visible
// part of the viewport in CSS pixels.
export function locateElement(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
    throw new Error("No visible element matches the selector.");
  }

  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) throw new Error("The element is outside the visible area.");
  return { x: left, y: top, width: right - left, height: bottom - top };
}
