import React from "react";

import { IWindow, IHighlight } from "common/interface";

import { EditorProvider } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";
import { FocusProvider } from "renderer/context/focus";

import { useApp } from "renderer/context/app";


import { TablineComponent } from "renderer/components/envim/tabline";
import { EditorComponent } from "renderer/components/envim/editor";
import { MessagesComponent } from "renderer/components/envim/messages";
import { CmdlineComponent } from "renderer/components/envim/cmdline";
import { PopupmenuComponent } from "renderer/components/envim/popupmenu";
import { AcpComponent } from "renderer/components/acp";
import { InputComponent } from "renderer/components/envim/input";

import { BrowserPaneComponent } from "renderer/components/browser/pane";
import { useBrowserWorkspace } from "renderer/context/browser";
import { useSurface } from "renderer/components/envim/surface";
import { FormHostComponent } from "renderer/components/form";

interface Props {
  header: { height: number; paddingLeft: number; paddingRight: number };
  main: { width: number; height: number; };
}

interface States {
  acp: boolean;
  grids: { [k: number]: {
    gid: number;
    revision: number;
    winid: number;
    order: number;
    focusable: boolean;
    focus: boolean
    shadow: boolean;
    type: "normal" | "floating" | "external";
    style: {
      zIndex: number;
      width: number;
      height: number;
      transform: string;
      visibility: "visible" | "hidden";
    };
  }};
}


const styles: { [k: string]: React.CSSProperties } = {
  // Hidden behind the browser but still focusable, so Neovim prompts (input()) keep working.
  backstage: { position: "absolute", opacity: 0, pointerEvents: "none" },
};

export function EnvimComponent(props: Props) {
  const [state, setState] = React.useState<States>({ acp: false, grids: {} });
  const { active, emit, highlights } = useWorkspace();
  const { setting: { font, options }, grid } = useApp();
  const { col2X, row2Y, x2Col, y2Row } = grid;
  const acp = { width: state.acp ? 400 : 0, height: props.main.height };
  const editor = { width: col2X(x2Col(props.main.width - acp.width - 8)), height: row2Y(y2Row(props.main.height - 8)) };
  const timer: React.RefObject<number> = React.useRef<number>(0);
  const browserState = useBrowserWorkspace();
  const editorInput = React.useRef<HTMLInputElement>(null);
  const { browser, toggle: toggleSurface, focusEditor } = useSurface(editorInput, browserState.tabs.length);

  React.useEffect(() => {
    highlights.setHighlight("0", true, {  });
    emit.on("acp:toggle", onAcpToggle);
    emit.on("neovim:ui:highlight:set", onNeovimUiHighlightSet);
    emit.on("neovim:ui:window:position", onNeovimUiWindowPosition);
    emit.send("neovim:ui:attach", x2Col(editor.width), y2Row(editor.height), options);

    return () => {
      emit.off("acp:toggle", onAcpToggle);
      emit.off("neovim:ui:highlight:set", onNeovimUiHighlightSet);
      emit.off("neovim:ui:window:position", onNeovimUiWindowPosition);
    };
  }, []);

  React.useEffect(() => {
    emit.send("neovim:ui:resize", 0, x2Col(editor.width), y2Row(editor.height));
  }, [editor.width, editor.height]);

  function onAcpToggle() {
    setState(state => ({ ...state, acp: !state.acp }));
  }

  function onNeovimUiHighlightSet(hls: {id: string, ui: boolean, hl: IHighlight}[]) {
    hls.forEach(({id, ui, hl}) => {
      highlights.setHighlight(id, ui, hl);
    });
  }

  function onNeovimUiWindowPosition(wins: IWindow[]) {
    setState(({ grids, ...state }) => {
      const nextOrder = Object.values(grids).reduce((order, grid) => Math.max(order, grid.order), 1);
      const refresh = wins.reverse().filter(({ gid, revision, winid, x, y, width, height, zIndex, focusable, focus, shadow, type, status }, i) => {
        const curr = grids[gid]?.style;
        const order = grids[gid]?.order || i + nextOrder;
        const next = {
          zIndex: (status === "show" ? zIndex : -1) + +focus ,
          width: col2X(width),
          height: row2Y(height),
          transform: `translate(${col2X(x)}px, ${row2Y(y)}px)`,
          visibility: status === "show" ? "visible" : "hidden" as "visible" | "hidden",
        };

        if (status === "delete") {
          delete(grids[gid]);
        } else if (grids[gid]?.revision !== revision || JSON.stringify(curr) !== JSON.stringify(next)) {
          grids[gid] = { gid, revision, winid, order, focusable, focus, shadow, type, style: next };
        }

        return type === "normal" && curr && (curr.visibility !== next.visibility || curr.width !== next.width || curr.height !== next.height);
      }).length > 0;

      clearTimeout(timer.current);
      timer.current = refresh ? +setTimeout(() => emit.send("neovim:command", "mode"), 100) : 0;

      return { ...state, grids };
    });
  }

  function onMouseUp() {
    emit.share("ui:drag", "");
  }

  return (
    <FocusProvider>
      <EditorProvider>
        <div style={{display: active ? undefined : "none"}} onMouseUp={onMouseUp}>
          <TablineComponent {...props.header} onToggleSurface={toggleSurface} onFocusEditor={focusEditor} browserState={browser ? browserState : undefined} />
          <div className="envim-main" style={props.main}>
            <div className="envim-row">
              <div className="envim-row envim-workspace" style={{
                "--envim-editor-font-size": `${font.size}px`,
                "--envim-editor-line-height": `${font.height}px`,
              } as React.CSSProperties}>
                <div className="envim-row envim-frame" style={{ ...editor, zIndex: 0, ...(browser ? styles.backstage : {}) }}>
                  { Object.values(state.grids).sort((a, b) => a.order - b.order).map(grid => (
                    <EditorComponent key={grid.gid} {...grid} font={font} />
                  )) }
                  <PopupmenuComponent />
                  <InputComponent input={editorInput} />
                </div>
                {browser && (
                  <div className="envim-row envim-surface envim-frame" style={{ ...editor, overflow: "hidden" }}>
                    {browserState.current && (
                      <BrowserPaneComponent key={browserState.current.id} tab={browserState.current}
                        visible={active} />
                    )}
                  </div>
                )}
                <CmdlineComponent />
                <MessagesComponent />
              </div>
              <div className="envim-row" style={{ ...acp, overflow: "hidden" }}>
                <AcpComponent />
              </div>
            </div>
          </div>
        </div>
        <FormHostComponent />
      </EditorProvider>
    </FocusProvider>
  );
}
