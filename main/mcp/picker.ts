import * as Electron from "electron";
import { randomUUID } from "crypto";

import type { IBrowserElement } from "common/interface";

import { pageSelector } from "main/mcp/page";

type Selection = Omit<IBrowserElement, "url">;
type PickerWorld = typeof globalThis & {
  envimElementPicker?: { key: string; next: () => Promise<Selection | null>; stop: () => void };
};

interface ActivePicker {
  endpoint: string;
  abort: () => void;
  done: Promise<void>;
}

const active = new Map<Electron.WebContents, ActivePicker>();

export function isPicking(guest: Electron.WebContents): boolean {
  return active.has(guest);
}

export function stopPicking(endpoint: string, guestId?: number): void {
  for (const [guest, picker] of active) {
    if (picker.endpoint === endpoint && (guestId === undefined || guest.id === guestId)) picker.abort();
  }
}

// Runs the in-page picker until it is stopped. A picker already running in the same guest is stopped first.
export async function pickElement(
  endpoint: string, guest: Electron.WebContents, isValid: () => boolean, onSelection: (selection: Selection) => void,
): Promise<void> {
  for (let previous = active.get(guest); previous; previous = active.get(guest)) {
    previous.abort();
    await previous.done;
  }

  const key = JSON.stringify(randomUUID());
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cancel = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
  const navigate = (event: Electron.WebContentsDidStartNavigationEventParams) => {
    if (event.isMainFrame && !event.isSameDocument) abort();
  };
  const picker = `(globalThis.envimElementPicker?.key === ${key} ? globalThis.envimElementPicker : null)`;
  let code = `(${elementPicker.toString()})(${pageSelector.toString()}, ${key})`;
  let finish!: () => void;
  active.set(guest, { endpoint, abort, done: new Promise(resolve => { finish = resolve; }) });
  guest.once("destroyed", abort);
  guest.on("did-start-navigation", navigate);
  guest.focus();

  try {
    while (!controller.signal.aborted) {
      const selection: Selection | null = await Promise.race([
        cancel, guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]),
      ]);
      if (!selection || controller.signal.aborted || guest.isDestroyed() || !isValid()) break;

      onSelection(selection);
      code = `${picker}?.next()`;
    }
  } finally {
    guest.removeListener("destroyed", abort);
    guest.removeListener("did-start-navigation", navigate);
    if (!guest.isDestroyed() && !guest.isLoadingMainFrame()) {
      await guest.executeJavaScriptInIsolatedWorld(1001, [{ code: `${picker}?.stop()` }]).catch(() => {});
    }
    active.delete(guest);
    finish();
  }
}

// Serialized into the guest's isolated world. All runtime dependencies are passed in.
export function elementPicker(getSelector: typeof pageSelector, key: string, trustedOnly = true) {
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

  // Choose the nearest HTML element in the main document, so the selector can be resolved
  // with document.querySelector (e.g. a button instead of the SVG path or shadow DOM node inside it).
  function element(event: Event): HTMLElement | undefined {
    return event.composedPath().find((item): item is HTMLElement =>
      item instanceof HTMLElement && item.getRootNode() === document &&
      item !== outline && item !== hover &&
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
