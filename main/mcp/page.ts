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

// scope is the URL prefix the page must still be on: the origin plus "/" for a web tab, or the
// mock preview URL. The mock preview runs sandboxed with an opaque origin, so origins cannot be compared.
export function runPageAction(
  scope: string, action: BrowserPageAction, selector: string | undefined, options: BrowserPageOptions,
) {
  const { pixels, text, option, checked } = options;
  if (!window.location.href.startsWith(scope)) throw new Error("The tab left the page it was used for.");

  const visible = (element: Element) => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible";

  if (action === "scroll" && selector === undefined) {
    window.scrollBy(0, pixels ?? 0);
    return "Scrolled the page.";
  }

  const element = document.querySelector(selector || "");
  if (!(element instanceof HTMLElement) || !visible(element)) throw new Error("No visible element matches the selector.");

  if (action === "scroll") {
    element.scrollBy(0, pixels ?? 0);
    return "Scrolled the element.";
  }

  if (element.matches(":disabled,[aria-disabled=true]")) throw new Error("The element is disabled.");
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (action === "type") {
    const textInput = element instanceof HTMLInputElement &&
      ["text", "search", "email", "tel", "url", "password", "number"].includes(element.type);
    const textArea = element instanceof HTMLTextAreaElement;
    if ((!textInput && !textArea && !element.isContentEditable) || element.matches("[readonly]")) {
      throw new Error("The element is not an editable text field.");
    }

    element.focus();
    const value = text ?? "";
    const inputType = "insertReplacementText";
    if (!element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType, data: value }))) {
      throw new Error("The page rejected text input.");
    }

    if (textInput || textArea) {
      const prototype = textInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    } else {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: value }));
    return "Entered text in the selected element.";
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

    // Clicking runs the page's handlers, as a user's click would.
    element.click();
    if (element.checked !== checked) throw new Error("The page did not change the checked state.");
    return `${checked ? "Checked" : "Unchecked"} the element.`;
  }

  element.click();
  return "Clicked the selected element.";
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
