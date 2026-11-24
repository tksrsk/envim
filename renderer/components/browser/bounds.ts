import React from "react";

import type { IBrowserViewport } from "common/interface";
import { useWorkspace } from "renderer/context/workspace";
import { menuLayoutEvent, menuOverlaps } from "renderer/components/menu";

export function useBrowserBounds(slot: React.RefObject<HTMLDivElement | null>, visible: boolean, tabId: number,
  viewport: IBrowserViewport | undefined, onReveal: () => void) {
  const { emit } = useWorkspace();

  React.useLayoutEffect(() => {
    const element = slot.current;
    if (!visible || !element) return;
    let last = "";
    function layout() {
      const bounds = element!.getBoundingClientRect();
      const rect = menuOverlaps(bounds) ? null : {
        x: Math.round(bounds.x), y: Math.round(bounds.y),
        width: Math.round(bounds.width), height: Math.round(bounds.height),
      };
      const key = JSON.stringify(rect);
      if (last !== key) {
        const reveal = last === "null" && rect;
        last = key;
        void emit.send("browser:bounds:update", rect);
        if (reveal) onReveal();
      }
    }
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    window.addEventListener("resize", layout);
    document.addEventListener("scroll", layout, true);
    document.addEventListener(menuLayoutEvent, layout);
    layout();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", layout);
      document.removeEventListener("scroll", layout, true);
      document.removeEventListener(menuLayoutEvent, layout);
      void emit.send("browser:bounds:update", null);
    };
  }, [visible, tabId, viewport]);
}
