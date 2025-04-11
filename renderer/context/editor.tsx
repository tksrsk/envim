import React, { createContext, useContext, useState, useEffect } from "react";

import { ISetting, ITab, IBuffer, IMode, IMenu } from "../../common/interface";

import { Emit } from "../utils/emit";
import { Setting } from "../utils/setting";

interface EditorContextType {
  busy: boolean;
  connections: ISetting["bookmarks"];
  options: ISetting["options"];
  mode?: IMode;
  tabs: ITab[];
  bufs: IBuffer[];
  drag: string;
  menus: IMenu[];
}

const EditorContext = createContext<EditorContextType>({
  busy: false,
  connections: [],
  options: Setting.options,
  tabs: [],
  bufs: [],
  menus: [],
  drag: "",
});

export const useEditor = () => useContext(EditorContext);

export const EditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<EditorContextType>({
    busy: false,
    connections: [],
    options: Setting.options,
    tabs: [],
    bufs: [],
    menus: [],
    drag: "",
  });

  useEffect(() => {
    Emit.on("app:busy", onBusy);
    Emit.on("option:set", onOption);
    Emit.on("mode:change", onMode);
    Emit.on("tabline:update", onTabline);
    Emit.on("menu:update", onMenu);
    Emit.on("envim:drag", onDrag);

    return () => {
      Emit.off("app:busy", onBusy);
      Emit.off("option:set", onOption);
      Emit.off("mode:change", onMode);
      Emit.off("tabline:update", onTabline);
      Emit.off("menu:update", onMenu);
      Emit.off("envim:drag", onDrag);
    };
  }, []);

  function onBusy (busy: boolean) {
    setState(state => ({ ...state, busy }));
  }

  function onOption(options: { [k: string]: boolean }) {
    Setting.options = options;
    setState(state => ({ ...state, options: { ...state.options, ...options } }));
  }

  function onMode (mode: IMode) {
    setState(state => ({ ...state, mode }));
  }

  async function onTabline(tabs: ITab[], bufs: IBuffer[]) {
    const buflist: { [key: number]: { filetype?: string, buftype?: string } } = {};

    for (let i = 0; i < tabs.length; i++) {
      const { buffer } = tabs[i];
      const { filetype, buftype } = buflist[buffer] || state.tabs.find(tab => tab.buffer === buffer) || {
        filetype: await Emit.send<string>("envim:api", "nvim_buf_get_option", [buffer, "filetype"]),
        buftype: await Emit.send<string>("envim:api", "nvim_buf_get_option", [buffer, "buftype"]),
      };

      buflist[buffer] = { filetype, buftype };
    }

    tabs = tabs.map(tab => ({ ...tab, ...buflist[tab.buffer] }))

    setState(state => ({ ...state, tabs, bufs }));
  }

  function onMenu(menus: IMenu[]) {
    setState(state => ({ ...state, menus }));
  }

  function onDrag (drag: string) {
    setState(state => ({ ...state, drag }));
  }

  return (
    <EditorContext.Provider value={state}>
      {children}
    </EditorContext.Provider>
  );
};

