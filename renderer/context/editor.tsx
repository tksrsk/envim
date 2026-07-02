import React from "react";

import { ISetting, ITab, IBuffer, IMode, IMenu } from "common/interface";

import { useWorkspace } from "renderer/context/workspace";
import { Setting } from "renderer/utils/setting";

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

const EditorContext = React.createContext<EditorContextType>({
  busy: false,
  connections: [],
  options: Setting.options,
  tabs: [],
  bufs: [],
  menus: [],
  drag: "",
});

export const useEditor = () => React.useContext(EditorContext);

export const EditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<EditorContextType>({
    busy: false,
    connections: [],
    options: Setting.options,
    tabs: [],
    bufs: [],
    menus: [],
    drag: "",
  });

  React.useEffect(() => {
    emit.on("app:busy", onBusy);
    emit.on("option:set", onOption);
    emit.on("mode:change", onMode);
    emit.on("tabline:update", onTabline);
    emit.on("menu:update", onMenu);
    emit.on("envim:drag", onDrag);

    return () => {
      emit.off("app:busy", onBusy);
      emit.off("option:set", onOption);
      emit.off("mode:change", onMode);
      emit.off("tabline:update", onTabline);
      emit.off("menu:update", onMenu);
      emit.off("envim:drag", onDrag);
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
