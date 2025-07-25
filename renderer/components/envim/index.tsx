import React, { useEffect, useState, useRef, RefObject } from "react";

import { ISetting, IWindow, IHighlight } from "common/interface";

import { EditorProvider } from "../../context/editor";

import { Emit } from "../../utils/emit";
import { Highlights } from "../../utils/highlight";
import { Setting } from "../../utils/setting";
import { y2Row, x2Col, row2Y, col2X } from "../../utils/size";

import { FlexComponent } from "../flex";

import { TablineComponent } from "./tabline";
import { EditorComponent } from "./editor";
import { HistoryComponent } from "./history";
import { CmdlineComponent } from "./cmdline";
import { PopupmenuComponent } from "./popupmenu";
import { NotificateComponent } from "./notificate";
import { InputComponent } from "./input";

interface Props {
  header: { width: number; height: number; paddingLeft: number };
  main: { width: number; height: number; };
  footer: { width: number; height: number; };
}

interface States {
  init: boolean;
  pause: boolean;
  grids: { [k: string]: {
    id: string;
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

const styles = {
  backdrop: {
    opacity: 0.2,
    cursor: "wait",
  }
};

export function EnvimComponent(props: Props) {
  const [state, setState] = useState<States>({ init: true, pause: false, grids: {} });
  const { size, height } = Setting.font;
  const timer: RefObject<number> = useRef<number>(0);

  useEffect(() => {
    Emit.on("app:switch", onSwitch);
    Emit.on("highlight:set", onHighlight);
    Emit.on("win:pos", onWin);
    Emit.on("envim:setting", onSetting);
    Emit.on("envim:pause", onPause);

    return () => {
      Emit.off("app:switch", onSwitch);
      Emit.off("highlight:set", onHighlight);
      Emit.off("win:pos", onWin);
      Emit.off("envim:setting", onSetting);
      Emit.off("envim:pause", onPause);
    };
  }, []);

  useEffect(() => {
    state.init
      ? Emit.send("envim:attach", x2Col(props.main.width), y2Row(props.main.height), Setting.options)
      : setState(state => ({ ...state, init: true }));
  }, [state.init]);

  useEffect(() => {
    Emit.send("envim:resize", 0, x2Col(props.main.width), y2Row(props.main.height));
  }, [props.main.width, props.main.height]);

  function onSwitch() {
    setState(({ grids, ...state }) => {
      Object.values(grids).forEach(grid => {
        grid.focus = false;
        grid.style.visibility = "hidden";
      });
      return { ...state, init: false, grids };
    });
  }

  function onHighlight(highlights: {id: string, ui: boolean, hl: IHighlight}[]) {
    highlights.forEach(({id, ui, hl}) => {
      Highlights.setHighlight(id, ui, hl);
    });
  }

  function onWin(wins: IWindow[]) {
    setState(({ grids, ...state }) => {
      const nextOrder = Object.values(grids).reduce((order, grid) => Math.max(order, grid.order), 1);
      const refresh = wins.reverse().filter(({ id, gid, winid, x, y, width, height, zIndex, focusable, focus, shadow, type, status }, i) => {
        const curr = grids[id]?.style;
        const order = grids[id]?.order || i + nextOrder;
        const next = {
          zIndex: (status === "show" ? zIndex : -1) + +focus ,
          width: col2X(width),
          height: row2Y(height),
          transform: `translate(${col2X(x)}px, ${row2Y(y)}px)`,
          visibility: status === "show" ? "visible" : "hidden" as "visible" | "hidden",
        };

        if (status === "delete") {
          delete(grids[id]);
        } else if (JSON.stringify(curr) !== JSON.stringify(next)) {
          grids[id] = { id, gid, winid, order, focusable, focus, shadow, type, style: next };
        }

        return type === "normal" && curr && (curr.visibility !== next.visibility || curr.width !== next.width || curr.height !== next.height);
      }).length > 0;

      clearTimeout(timer.current);
      timer.current = refresh ? +setTimeout(() => Emit.send("envim:command", "mode"), 100) : 0;

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
    Emit.share("envim:drag", "");
    Emit.share("envim:focus");
  }

  return (
    <EditorProvider>
      <div style={{fontSize: size, lineHeight: `${height}px`}} onMouseUp={onMouseUp}>
        { state.init && <TablineComponent {...props.header} /> }
        <FlexComponent zIndex={0}>
          <FlexComponent color="default" zIndex={-1} grow={1} shrink={1} />
          <FlexComponent zIndex={0} direction="column" overflow="visible">
            <div className="color-default" style={{height: Setting.font.height}} />
            <FlexComponent overflow="visible" style={props.main}>
              { Object.values(state.grids).sort((a, b) => a.order - b.order).map(grid => (
                <EditorComponent key={grid.id} { ...grid } />
              )) }
              { state.init && <PopupmenuComponent /> }
              { state.init && <InputComponent /> }
            </FlexComponent>
          </FlexComponent>
          { state.init && <CmdlineComponent /> }
          { state.init && <NotificateComponent /> }
          <FlexComponent color="default" zIndex={-1} grow={1} shrink={1} />
        </FlexComponent>
        { state.init && <HistoryComponent {...props.footer} /> }
        { state.pause && (
          <FlexComponent direction="column" horizontal="center" vertical="center" color="default" position="absolute" zIndex={100} inset={[0]} style={styles.backdrop}>
            <div className="animate loading" />
          </FlexComponent>
        ) }
      </div>
    </EditorProvider>
  );
}
