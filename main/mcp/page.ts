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

export function runPageAction(
  origin: string, action: BrowserPageAction, selector: string | undefined, pixels: number | undefined, text: string | undefined,
  getSelector: typeof pageSelector,
) {
  if (window.location.origin !== origin) throw new Error("The shared tab changed origin.");

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
