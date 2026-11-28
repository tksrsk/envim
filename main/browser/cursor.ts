// Runs in the page's isolated world. Keep all DOM dependencies inside this function.
export function adjacentElementPoint(
  cursor: { x: number; y: number; width: number; height: number },
  zoom: number,
  forward: boolean,
): { x: number; y: number } | null {
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[contenteditable]:not([contenteditable=false])", "[tabindex]",
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  ].join(",");
  const scale = zoom * (window.visualViewport?.scale || 1);
  const maxX = Math.floor((window.visualViewport?.width ?? window.innerWidth) * scale) - cursor.width;
  const maxY = Math.floor((window.visualViewport?.height ?? window.innerHeight) * scale) - cursor.height;
  const current = document.elementFromPoint(cursor.x / scale, cursor.y / scale)?.closest(selector);
  const elements = Array.from(document.querySelectorAll(selector));
  const currentIndex = current ? elements.indexOf(current) : -1;
  const candidates = forward ? elements.slice(currentIndex + 1) :
    elements.slice(0, currentIndex < 0 ? elements.length : currentIndex).reverse();

  let nearest: { x: number; y: number; vertical: number; horizontal: number } | undefined;
  for (const element of candidates) {
    if (element.matches(":disabled") || element.closest('[inert], [aria-disabled="true"]')) continue;
    for (const rect of element.getClientRects()) {
      const left = Math.max(0, Math.ceil(rect.left * scale));
      const top = Math.max(0, Math.ceil(rect.top * scale));
      const right = Math.min(maxX, Math.ceil(rect.right * scale) - 1);
      const bottom = Math.min(maxY, Math.ceil(rect.bottom * scale) - 1);
      if (left > right || top > bottom) continue;
      const x = Math.floor((left + right) / 2);
      const y = Math.floor((top + bottom) / 2);
      const hit = document.elementFromPoint(x / scale, y / scale);
      if (hit?.closest(selector) !== element) continue;
      if (currentIndex >= 0) return { x, y };

      // Prefer elements on the cursor's row, then the nearest row in the direction of travel.
      const rowOffset = cursor.y < top ? top - cursor.y : Math.min(0, bottom - cursor.y);
      const offset = rowOffset || x - cursor.x;
      if (forward ? offset <= 0 : offset >= 0) continue;
      const vertical = Math.abs(rowOffset);
      const horizontal = Math.abs(x - cursor.x);
      if (!nearest || vertical < nearest.vertical || (vertical === nearest.vertical && horizontal < nearest.horizontal)) {
        nearest = { x, y, vertical, horizontal };
      }
    }
  }

  return nearest ? { x: nearest.x, y: nearest.y } : null;
}
