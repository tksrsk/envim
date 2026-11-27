import React from "react";

import type { BrowserTabCommand, IWorkspaceBrowserTab } from "common/interface";
import { useWorkspace } from "renderer/context/workspace";
import { col2X, row2Y } from "renderer/utils/size";

type InputRef = React.RefObject<HTMLInputElement | null>;

interface Options {
  tab: IWorkspaceBrowserTab;
  area: React.RefObject<HTMLDivElement | null>;
  commandInput: InputRef;
  address: InputRef;
  searchInput: InputRef;
  search: string;
  command: (...command: BrowserTabCommand) => unknown;
  picking: () => boolean;
  togglePicker: () => void;
}

export function useCommandMode({ tab, area, commandInput, address, searchInput, search, command, picking, togglePicker }: Options) {
  const { emit } = useWorkspace();
  const cursor = React.useRef({ x: 0, y: 0 });
  const anchor = React.useRef<{ x: number; y: number; line: boolean } | undefined>(undefined);
  const [mode, setMode] = React.useState<"command" | "visual">();

  function cursorRect() {
    const width = col2X(1);
    const height = row2Y(1);
    const x = Math.max(0, Math.min(cursor.current.x, (area.current?.clientWidth ?? 0) - width));
    const y = Math.max(0, Math.min(cursor.current.y, (area.current?.clientHeight ?? 0) - height));
    return { x, y, width, height };
  }

  function selectionRect() {
    const point = cursorRect();
    const start = anchor.current;
    if (!start) return point;
    return {
      x: start.line ? 0 : Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: start.line ? area.current?.clientWidth ?? 0 : Math.abs(point.x - start.x) + point.width,
      height: Math.abs(point.y - start.y) + point.height,
    };
  }

  function focusCommand() {
    if (tab.url === "about:blank") address.current?.focus();
    else commandInput.current?.focus();
  }

  function onTextKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    focusCommand();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y, width, height } = cursorRect();
    function move(nextX: number, nextY: number) {
      cursor.current = { x: nextX, y: nextY };
      const point = cursorRect();
      cursor.current = point;
      void command("cursor", { point, selection: selectionRect() });
    }

    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case "r": return void command("reload");
        case "o": return void command("back");
        case "i": return void command("forward");
        case "h": case "j": case "k": case "l": case "u": case "d": return void command("scroll", { direction: event.key, point: cursorRect() });
        case "t": return void emit.send("browser:open", "");
      }
      return;
    }

    const right = area.current?.clientWidth ?? 0;
    const bottom = area.current?.clientHeight ?? 0;
    switch (event.key) {
      case "h": return move(x - width, y);
      case "j": return move(x, y + height);
      case "k": return move(x, y - height);
      case "l": return move(x + width, y);
      case "H": return move(x, 0);
      case "M": return move(x, Math.floor(bottom / 2));
      case "L": return move(x, bottom);
      case "0": return move(0, y);
      case "$": return move(right, y);
      case "b": return move(x - width * 15, y);
      case "w": return move(x + width * 15, y);
      case "n": case "N": return void (search ? command("find", search, event.key === "n") : command("stop-find"));
      case "g": case "G":
        void command("scroll-edge", event.key === "g" ? "top" : "bottom");
        return move(x, event.key === "g" ? 0 : bottom);
      case "v": case "V": {
        const line = event.key === "V";
        anchor.current = anchor.current?.line === line ? undefined : { x, y, line };
        setMode(anchor.current ? "visual" : "command");
        return void command("selection", selectionRect());
      }
      case "y":
        if (anchor.current) {
          void command("capture", selectionRect());
          anchor.current = undefined;
          setMode("command");
          void command("selection", selectionRect());
        }
        return;
      case "Y": if (!anchor.current) void command("capture"); return;
      case "-": return void command("zoom", Math.max(-0.9, tab.zoom - 0.1));
      case "+": return void command("zoom", Math.min(2, tab.zoom + 0.1));
      case "i": return void command("focus");
      case ":": return address.current?.focus();
      case "/": return searchInput.current?.focus();
      case "Escape":
        if (picking()) togglePicker();
        if (mode === "command") void command("send-escape");
        anchor.current = undefined;
        setMode("command");
        void command("selection", selectionRect());
        return void command(tab.loading ? "stop" : "stop-find");
      case "Enter": return void command("cursor-click", cursorRect());
    }
  }

  function onFocus() {
    setMode("command");
    void command("selection", selectionRect());
  }

  function onBlur() {
    anchor.current = undefined;
    setMode(undefined);
    void command("selection", null);
  }

  return { mode, selectionRect, focusCommand, onTextKey, onKeyDown, onFocus, onBlur };
}
