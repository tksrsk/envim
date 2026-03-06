import React, { useEffect, useState, useRef, RefObject } from "react";

import { useEditor } from "../../context/editor";

import { Emit } from "../../utils/emit";
import { Setting } from "../../utils/setting";
import { Highlights } from "../../utils/highlight";
import { row2Y, col2X, x2Col } from "../../utils/size";

import { FlexComponent } from "../flex";

interface States {
  items: { word: string, kind: string, menu: string }[];
  selected: number;
  clicked: boolean;
  row: number;
  col: number;
  height: number;
  zIndex: number;
  enabled: boolean;
}

export function PopupmenuComponent() {
  const { options } = useEditor();
  const [ state, setState ] = useState<States>({ items: [], selected: -1, clicked: false, row: 0, col: 0, height: 0, zIndex: 0, enabled: options.ext_popupmenu });
  const scope: RefObject<HTMLDivElement | null> = useRef(null);

  useEffect(() => {
    Emit.on("popupmenu:show", onPopupmenu);
    Emit.on("popupmenu:select", onSelect);
    Emit.on("popupmenu:hide", offPopupmenu);

    return () => {
      Emit.off("popupmenu:show", onPopupmenu);
      Emit.off("popupmenu:select", onSelect);
      Emit.off("popupmenu:hide", offPopupmenu);
    };
  });

  useEffect(() => {
    if (!scope.current?.clientWidth || state.items.length === 0) return;

    const width = x2Col(scope.current.clientWidth) + 2;

    Emit.send("envim:api", "nvim_ui_pum_set_bounds", [width, state.height, state.row, state.col]);
  }, [scope.current?.clientWidth, state.items.length, state.height, state.row, state.col]);

  function onPopupmenu(state: States) {
    state.col--;

    setState(({ enabled }) => ({ ...state, enabled }));
    Emit.share("envim:drag", -1);
  }

  function onSelect(selected: number) {
    setState(state => {
      const top = row2Y(Math.max(0, Math.min(selected, state.items.length - state.height)));

      state.clicked || setTimeout(() => scope.current?.parentElement?.scrollTo({ top, behavior: "smooth" }));
      return { ...state, selected, clicked: false };
    });
  }

  function offPopupmenu() {
    setState(state => ({ ...state, items: [] }));
    Emit.share("envim:drag", "");
  }

  useEffect(() => {
    options.ext_popupmenu === undefined || setState(state => ({ ...state, enabled: options.ext_popupmenu }));
  }, [options.ext_popupmenu]);

  function onItem(i: number) {
    setState(state => ({ ...state, clicked: true }));
    Emit.send("envim:api", "nvim_select_popupmenu_item", [i, true, false, {}]);
  }

  function getScopeStyle() {
    return {
      transform: `translate(${col2X(state.col)}px, ${row2Y(state.row)}px)`,
      height: row2Y(state.height),
      zIndex: state.zIndex,
    };
  }

  function getKindStyle(kind: string) {
    switch (kind[0].charCodeAt(0) % 6) {
      case 0: return "red";
      case 1: return "green";
      case 2: return "lightblue";
      case 3: return "purple";
      case 4: return "yellow";
      case 5: return "orange";
      default: return "default";
    }
  }

  return state.enabled && state.items.length > 0 && (
    <FlexComponent animate="fade-in" color="default" direction="column" position="absolute" overflow="auto" whiteSpace="pre-wrap" style={getScopeStyle()} shadow>
      <div ref={scope}></div>
      {state.items.map(({ word, kind, menu }, i) => (
        <FlexComponent active={state.selected === i} onClick={() => onItem(i)} key={i}>
          <FlexComponent padding={[0, Setting.font.width]} grow={1} style={Highlights.style("0")}>{ word }</FlexComponent>
          { `${kind}${menu}` && <FlexComponent padding={[0, Setting.font.width]} color={getKindStyle(`${kind}${menu}`)}>{ kind } { menu }</FlexComponent> }
        </FlexComponent>
      ))}
    </FlexComponent>
  );
}
