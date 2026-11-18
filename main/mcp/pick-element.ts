import type { pageSelector } from "main/mcp/browser-page";
import type { IMockPreviewElement } from "common/interface";

type Selection = Omit<IMockPreviewElement, "url">;
type PickerWorld = typeof globalThis & {
  envimElementPicker?: { key: string; next: () => Promise<Selection | null>; stop: () => void };
};

// Serialized into the guest's isolated world. All runtime dependencies are passed in.
export function pickMockElement(getSelector: typeof pageSelector, key: string, trustedOnly = true) {
  const scope = globalThis as PickerWorld;
  scope.envimElementPicker?.stop();
  const hover = document.createElement("div");
  const outline = document.createElement("div");
  const style = { position: "fixed", pointerEvents: "none", zIndex: "2147483647", display: "none" };
  Object.assign(hover.style, style, { outline: "2px dotted #9968cc" });
  Object.assign(outline.style, style, { outline: "2px solid #9968cc", background: "#9968cc24" });
  document.documentElement.append(hover, outline);

  let selected: Element | undefined;
  let hovered: Element | undefined;
  let queued: Selection | undefined;
  let waiting: ((value: Selection | null) => void) | undefined;

  function element(event: Event): Element | undefined {
    return event.composedPath().find((item): item is Element =>
      item instanceof Element && item !== outline && item !== hover &&
      item !== document.documentElement && item !== document.body
    );
  }

  function draw(box: HTMLElement, target?: Element) {
    const rect = target?.isConnected ? target.getBoundingClientRect() : undefined;
    box.style.display = rect ? "block" : "none";
    if (rect) {
      Object.assign(box.style, {
        left: rect.left + "px", top: rect.top + "px",
        width: rect.width + "px", height: rect.height + "px",
      });
    }
  }

  function redraw() {
    draw(hover, hovered === selected ? undefined : hovered);
    draw(outline, selected);
  }

  function highlight(event: PointerEvent) {
    hovered = element(event);
    redraw();
  }

  function leave() {
    hovered = undefined;
    redraw();
  }

  function consume(event: Event) {
    if (trustedOnly && !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function select(event: MouseEvent) {
    if (trustedOnly && !event.isTrusted) return;
    consume(event);
    const target = element(event);
    if (!target) return;

    selected = target;
    redraw();
    const control = target as HTMLInputElement;
    const label = control.labels?.[0]?.textContent;
    const selection = {
      selector: getSelector(target),
      tag: target.localName,
      label: (target.getAttribute("aria-label") || target.getAttribute("title") ||
        label || target.textContent || target.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 160),
    };
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(selection);
    } else {
      queued = selection;
    }
  }

  function cancel(event: KeyboardEvent) {
    if (event.key !== "Escape" || (trustedOnly && !event.isTrusted)) return;
    consume(event);
    stop();
  }

  function stop() {
    hover.remove();
    outline.remove();
    window.removeEventListener("pointermove", highlight, true);
    document.documentElement.removeEventListener("pointerleave", leave);
    window.removeEventListener("pointerdown", consume, true);
    window.removeEventListener("pointerup", consume, true);
    window.removeEventListener("click", select, true);
    window.removeEventListener("keydown", cancel, true);
    window.removeEventListener("scroll", redraw, true);
    window.removeEventListener("resize", redraw);
    delete scope.envimElementPicker;
    waiting?.(null);
  }

  function next(): Promise<Selection | null> {
    if (queued) {
      const value = queued;
      queued = undefined;
      return Promise.resolve(value);
    }
    return new Promise(resolve => { waiting = resolve; });
  }

  scope.envimElementPicker = { key, next, stop };
  window.addEventListener("pointermove", highlight, true);
  document.documentElement.addEventListener("pointerleave", leave);
  window.addEventListener("pointerdown", consume, true);
  window.addEventListener("pointerup", consume, true);
  window.addEventListener("click", select, true);
  window.addEventListener("keydown", cancel, true);
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw);
  return next();
}
