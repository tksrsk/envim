export type BrowserPageAction = "inspect" | "click" | "scroll" | "type";

// Serialized into Electron's isolated world. Keep both functions self-contained.
export function pageSelector(target: Element): string {
  const segments: string[] = [];
  for (let node: Element | null = target; node; node = node.parentElement) {
    const id = node.id && "#" + CSS.escape(node.id);
    if (id && document.querySelectorAll(id).length === 1) {
      segments.unshift(id);
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
  scope: string, action: BrowserPageAction, selector: string | undefined, pixels: number | undefined, text: string | undefined,
  getSelector: typeof pageSelector,
) {
  if (!window.location.href.startsWith(scope)) throw new Error("The tab left the page it was used for.");

  const visible = (element: Element) => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible";

  if (action === "inspect") {
    const interactive = "a[href],button,input:not([type=hidden]),select,textarea,[contenteditable]:not([contenteditable=false]),summary,[role=button],[role=tab],[role=link]";
    const elements = Array.from(document.querySelectorAll<HTMLElement>(interactive)).filter(visible).slice(0, 50).map(element => ({
      selector: getSelector(element),
      label: (element.getAttribute("aria-label") || element.textContent || element.getAttribute("title") ||
        element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 160),
    }));
    return {
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 6000) || "",
      elements,
    };
  }

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

  element.click();
  return "Clicked the selected element.";
}

// Serialized into Electron's isolated world. Returns whether the wait condition holds on the page in scope.
// With only selector, a visible matching element; with text, the text in that element or the page body;
// with neither, a fully loaded document. gone inverts the result. Returns "invalid-selector" for a
// selector the page cannot parse, since errors thrown here reach the main process without their message.
export function checkPageCondition(scope: string, selector: string | undefined, text: string | undefined, gone: boolean) {
  if (!window.location.href.startsWith(scope)) return false;

  let found: boolean;
  if (selector !== undefined) {
    let element: Element | null;
    try {
      element = document.querySelector(selector);
    } catch {
      return "invalid-selector";
    }
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
