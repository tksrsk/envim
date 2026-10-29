import React from "react";

import { IWindow, IHighlight } from "common/interface";

import { EditorProvider } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { y2Row, x2Col, row2Y, col2X } from "renderer/utils/size";

import { FlexComponent } from "renderer/components/flex";

import { TablineComponent } from "renderer/components/envim/tabline";
import { EditorComponent } from "renderer/components/envim/editor";
import { HistoryComponent } from "renderer/components/envim/history";
import { CmdlineComponent } from "renderer/components/envim/cmdline";
import { PopupmenuComponent } from "renderer/components/envim/popupmenu";
import { NotificateComponent } from "renderer/components/envim/notificate";
import { AcpComponent } from "renderer/components/acp";
import { InputComponent } from "renderer/components/envim/input";

interface Props {
  header: { width: number; height: number; paddingLeft: number };
  main: { width: number; height: number; };
  footer: { width: number; height: number; };
}

interface States {
  pause: boolean;
  acp: boolean;
  grids: { [k: number]: {
    gid: number;
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
  backdrop: {
    opacity: 0.2,
    cursor: "wait",
  }
};

export function EnvimComponent(props: Props) {
  const [state, setState] = React.useState<States>({ pause: false, acp: false, grids: {} });
  const { active, emit, highlights } = useWorkspace();
  const acp = { width: state.acp ? 400 : 0, height: row2Y(y2Row(props.main.height) - 1) };
  const editor = { width: col2X(x2Col(props.main.width - acp.width) - 2), height: acp.height };
  const timer: React.RefObject<number> = React.useRef<number>(0);

  React.useEffect(() => {
    highlights.setHighlight("0", true, {  });
    Emit.on("app:pause", onAppPause);
    emit.on("acp:toggle", onAcpToggle);
    emit.on("neovim:ui:highlight:set", onNeovimUiHighlightSet);
    emit.on("neovim:ui:window:position", onNeovimUiWindowPosition);
    emit.send("neovim:ui:attach", x2Col(editor.width), y2Row(editor.height), Setting.options);

    return () => {
      Emit.off("app:pause", onAppPause);
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

  function onAppPause(pause: boolean) {
    setState(state => ({ ...state, pause }));
  }

  function onNeovimUiHighlightSet(hls: {id: string, ui: boolean, hl: IHighlight}[]) {
    hls.forEach(({id, ui, hl}) => {
      highlights.setHighlight(id, ui, hl);
    });
  }

  function onNeovimUiWindowPosition(wins: IWindow[]) {
    setState(({ grids, ...state }) => {
      const nextOrder = Object.values(grids).reduce((order, grid) => Math.max(order, grid.order), 1);
      const refresh = wins.reverse().filter(({ gid, winid, x, y, width, height, zIndex, focusable, focus, shadow, type, status }, i) => {
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
        } else if (JSON.stringify(curr) !== JSON.stringify(next)) {
          grids[gid] = { gid, winid, order, focusable, focus, shadow, type, style: next };
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
    emit.share("ui:focus");
  }

  return (
    <EditorProvider>
      <div style={{display: active ? undefined : "none"}} onMouseUp={onMouseUp}>
        <TablineComponent {...props.header} />
        <FlexComponent zIndex={0} direction="column" style={props.main}>
          <FlexComponent color="default" grow={1} />
          <FlexComponent>
            <FlexComponent zIndex={0} grow={1} shrink={1}>
              <FlexComponent color="default" zIndex={-1} grow={1} />
              <FlexComponent zIndex={0} overflow="visible" style={editor}>
                { Object.values(state.grids).sort((a, b) => a.order - b.order).map(grid => (
                  <EditorComponent key={grid.gid} { ...grid } />
                )) }
                <PopupmenuComponent />
                <InputComponent />
              </FlexComponent>
              <FlexComponent color="default" zIndex={-1} grow={1} />
              <CmdlineComponent />
              <NotificateComponent />
            </FlexComponent>
            <FlexComponent style={acp}>
              <AcpComponent />
            </FlexComponent>
          </FlexComponent>
        </FlexComponent>
        <HistoryComponent {...props.footer} />
        { state.pause && (
          <FlexComponent direction="column" horizontal="center" vertical="center" color="default" position="absolute" zIndex={100} inset={[0]} style={styles.backdrop}>
            <div className="animate loading" />
          </FlexComponent>
        ) }
      </div>
    </EditorProvider>
  );
}
