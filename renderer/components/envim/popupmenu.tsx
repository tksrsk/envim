import React from "react";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";

import { Setting } from "renderer/utils/setting";
import { row2Y, col2X } from "renderer/utils/size";


interface States {
  items: { word: string, kind: string, menu: string }[];
  selected: number;
  row: number;
  col: number;
  height: number;
  zIndex: number;
  enabled: boolean;
}

export function PopupmenuComponent() {
  const { options } = useEditor();
  const { active, emit, highlights } = useWorkspace();
  const [ state, setState ] = React.useState<States>({ items: [], selected: -1, row: 0, col: 0, height: 0, zIndex: 0, enabled: options.ext_popupmenu });
  const scope: React.RefObject<HTMLDivElement | null> = React.useRef(null);

  React.useEffect(() => {
    emit.on("neovim:ui:popupmenu:show", onNeovimUiPopupmenuShow);
    emit.on("neovim:ui:popupmenu:select", onNeovimUiPopupmenuSelect);
    emit.on("neovim:ui:popupmenu:hide", onNeovimUiPopupmenuHide);

    return () => {
      emit.off("neovim:ui:popupmenu:show", onNeovimUiPopupmenuShow);
      emit.off("neovim:ui:popupmenu:select", onNeovimUiPopupmenuSelect);
      emit.off("neovim:ui:popupmenu:hide", onNeovimUiPopupmenuHide);
    };
  }, [emit]);

  React.useLayoutEffect(() => {
    const popup = scope.current;
    const grid = popup?.parentElement;
    if (!active || !popup || !grid) return;

    let previousBounds: number[] | undefined;

    function reportBounds(popup: HTMLDivElement, grid: HTMLElement) {
      const rect = popup.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const origin = grid.getBoundingClientRect();
      const bounds = [
        rect.width / col2X(1),
        rect.height / row2Y(1),
        (rect.top - origin.top) / row2Y(1),
        (rect.left - origin.left) / col2X(1),
      ];
      if (bounds.every((value, i) => value === previousBounds?.[i])) return;

      previousBounds = bounds;
      void emit.send("neovim:api", "nvim_ui_pum_set_bounds", bounds);
    }

    reportBounds(popup, grid);
    const observer = new ResizeObserver(() => reportBounds(popup, grid));
    observer.observe(popup, { box: "border-box" });
    return () => observer.disconnect();
  }, [active, emit, state.enabled, state.items, state.row, state.col, state.height]);

  React.useLayoutEffect(() => {
    const popup = scope.current;
    const selected = popup?.children.item(state.selected) as HTMLElement | null | undefined;
    if (!popup || !selected) return;

    const top = selected.offsetTop;
    const bottom = top + selected.offsetHeight;
    if (top < popup.scrollTop) {
      popup.scrollTop = top;
    } else if (bottom > popup.scrollTop + popup.clientHeight) {
      popup.scrollTop = bottom - popup.clientHeight;
    }
  }, [state.enabled, state.items, state.selected]);

  function onNeovimUiPopupmenuShow(state: States) {
    setState(({ enabled }) => ({ ...state, col: Math.max(0, state.col - 1), enabled }));
    emit.share("ui:drag", -1);
  }

  function onNeovimUiPopupmenuSelect(selected: number) {
    setState(state => ({ ...state, selected }));
  }

  function onNeovimUiPopupmenuHide() {
    setState(state => ({ ...state, items: [] }));
    emit.share("ui:drag", "");
  }

  React.useEffect(() => {
    options.ext_popupmenu === undefined || setState(state => ({ ...state, enabled: options.ext_popupmenu }));
  }, [options.ext_popupmenu]);

  function getKindStyle(kind: string) {
    const color = ["red", "green", "cyan", "violet", "yellow", "orange"][kind.charCodeAt(0) % 6];

    return { color: `var(--mantine-color-${color}-text)`, background: `var(--mantine-color-${color}-light)` };
  }

  const { background, color } = highlights.style("0");

  return state.enabled && state.height > 0 && state.items.length > 0 && (
    <div ref={scope} className="envim-pum" style={{
      left: col2X(state.col),
      top: row2Y(state.row),
      maxWidth: `calc(100% - ${col2X(state.col)}px)`,
      height: row2Y(state.height),
      zIndex: state.zIndex,
      background,
      color,
    }}>
      {state.items.map(({ word, kind, menu }, i) => {
        const label = [kind.trim(), menu.trim()].filter(Boolean).join(" ");

        return (
          <div className="envim-pum-item" data-selected={state.selected === i || undefined}
            style={{ height: row2Y(1), paddingInlineStart: Setting.font.width }}
            onClick={() => void emit.send("neovim:api", "nvim_select_popupmenu_item", [i, true, false, {}])}
            key={i}>
            <span className="envim-pum-word">{word}</span>
            {label && <span className="envim-pum-kind" style={getKindStyle(label)}>{label}</span>}
          </div>
        );
      })}
    </div>
  );
}
