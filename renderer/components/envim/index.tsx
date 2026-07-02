import React from "react";

import { ISetting, IWindow, IHighlight } from "common/interface";

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
  const [state, setState] = React.useState<States>({ pause: false, grids: {} });
  const { active, emit, highlights } = useWorkspace();
  const { size, height } = Setting.font;
  const timer: React.RefObject<number> = React.useRef<number>(0);

  React.useEffect(() => {
    highlights.setHighlight("0", true, {  });
    emit.on("highlight:set", onHighlight);
    emit.on("win:pos", onWin);
    Emit.on("envim:setting", onSetting);
    Emit.on("envim:pause", onPause);
    emit.send("envim:attach", x2Col(props.main.width), y2Row(props.main.height), Setting.options);

    return () => {
      emit.off("highlight:set", onHighlight);
      emit.off("win:pos", onWin);
      Emit.off("envim:setting", onSetting);
      Emit.off("envim:pause", onPause);
    };
  }, []);

  React.useEffect(() => {
    emit.send("envim:resize", 0, x2Col(props.main.width), y2Row(props.main.height));
  }, [props.main.width, props.main.height]);

  function onHighlight(hls: {id: string, ui: boolean, hl: IHighlight}[]) {
    hls.forEach(({id, ui, hl}) => {
      highlights.setHighlight(id, ui, hl);
    });
  }

  function onWin(wins: IWindow[]) {
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
      timer.current = refresh ? +setTimeout(() => emit.send("envim:command", "mode"), 100) : 0;

      return { ...state, grids };
    });
  }

  function onSetting(setting: ISetting) {
    Setting.searchengines = setting.searchengines;
  }

  function onPause(pause: boolean) {
    setState(state => ({ ...state, pause }));
  }

  function onMouseUp() {
    emit.share("envim:drag", "");
    emit.share("envim:focus");
  }

  return (
    <EditorProvider>
      <div style={{fontSize: size, lineHeight: `${height}px`, display: active ? undefined : "none"}} onMouseUp={onMouseUp}>
        <TablineComponent {...props.header} />
        <FlexComponent zIndex={0}>
          <FlexComponent color="default" zIndex={-1} grow={1} shrink={1} />
          <FlexComponent zIndex={0} direction="column" overflow="visible">
            <div className="color-default" style={{height: Setting.font.height}} />
            <FlexComponent overflow="visible" style={props.main}>
              { Object.values(state.grids).sort((a, b) => a.order - b.order).map(grid => (
                <EditorComponent key={grid.gid} { ...grid } />
              )) }
              <PopupmenuComponent />
              <InputComponent />
            </FlexComponent>
          </FlexComponent>
          <CmdlineComponent />
          <NotificateComponent />
          <AcpComponent />
          <FlexComponent color="default" zIndex={-1} grow={1} shrink={1} />
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
