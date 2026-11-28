import React from "react";

import { useApp } from "renderer/context/app";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";
import { useFocus } from "renderer/context/focus";

import { keycode } from "renderer/utils/keycode";


interface States {
  cursor: { x: number, y: number, width: number, zIndex: number, shape: "block" | "vertical" | "horizontal" };
  value: string;
  busy: boolean;
}

const styles: { [k: string]: React.CSSProperties } = {
  input: {
    position: "absolute",
    width: "100%",
    border: 0,
    background: "transparent",
    color: "transparent",
    padding: 0,
    margin: 0,
    caretColor: "transparent",
    outline: "none",
  },
};

export function InputComponent({ input }: { input: React.RefObject<HTMLInputElement | null> }) {
  const { busy, mode } = useEditor();
  const { grid } = useApp();
  const { col2X, row2Y } = grid;
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<States>({ cursor: { x: 0, y: 0, width: 0, zIndex: 0, shape: "block" }, value: "", busy });
  const { active, targets } = useFocus();
  const focused = active === input.current;
  const restore = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    targets.push(input);
    emit.on("neovim:ui:grid:cursor", onNeovimUiGridCursor);

    return () => {
      targets.splice(targets.indexOf(input), 1);
      emit.off("neovim:ui:grid:cursor", onNeovimUiGridCursor);
    };
  }, []);

  function onNeovimUiGridCursor (cursor: { x: number, y: number, width: number, hl: string, zIndex: number }) {
    setState(state => ({ ...state, cursor: { ...state.cursor, ...cursor }}));
  }

  React.useEffect(() => {
    setState(state => ({ ...state, busy }));
  }, [busy]);

  React.useEffect(() => {
    if (mode) {
      setState(state => ({ ...state, cursor: { ...state.cursor, shape: mode.cursor_shape }}));
      if (mode.short_name === "c") {
        document.activeElement !== input.current && (restore.current = document.activeElement as HTMLElement | null);
        input.current?.focus();
      } else if (restore.current) {
        restore.current.focus();
        restore.current = null;
      }
    }
  }, [mode]);

  function makeStyle() {
    const cursor = state.cursor;
    const multibyte = (encodeURIComponent(state.value).replace(/%../g, "x").length - state.value.length) / 2;
    const offset = Math.max(col2X(cursor.x + state.value.length + multibyte + 1) - document.body.clientWidth, 0);

    return {
      minWidth: state.busy || !focused ? 0 : col2X(state.cursor.width),
      height: row2Y(1),
      transform: `translate(${col2X(cursor.x) - offset}px, ${row2Y(cursor.y)}px)`,
      zIndex: cursor.zIndex,
      borderRadius: 2,
      ...({
        horizontal: { borderBottom: "2px solid var(--mantine-color-text)" },
        vertical: { borderLeft: "2px solid var(--mantine-color-text)" },
        block: { backdropFilter: "invert(1)" },
      }[cursor.shape]),
    };
  }

  function onKeyDown (e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;
    const code = keycode(e);

    e.stopPropagation();
    e.preventDefault();

    code && emit.send("neovim:input", code);
  }

  function onKeyUp (e: React.KeyboardEvent) {
    if (!e.nativeEvent.isComposing && input.current?.value) {
      emit.send("neovim:input", input.current.value);
      input.current.value = "";
    }

    (input.current?.value || state.value) && setState(state => ({ ...state, value: input.current?.value || "" }));
  }

  return (
    <div className="animate fade-in envim-input" data-shadow={(!state.busy && focused && state.cursor.shape === "block") || undefined} style={makeStyle()}>
      <input type="text" style={styles.input} ref={input} tabIndex={-1} autoFocus
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      />
      <div className="envim-input-value">{ state.value }</div>
    </div>
  );
}
