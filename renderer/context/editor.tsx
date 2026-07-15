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
  drag: "" | number;
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
    emit.on("neovim:ui:busy", onNeovimUiBusy);
    emit.on("neovim:ui:option:set", onNeovimUiOptionSet);
    emit.on("neovim:ui:mode:change", onNeovimUiModeChange);
    emit.on("neovim:ui:tabline:update", onNeovimUiTablineUpdate);
    emit.on("neovim:ui:menu:update", onNeovimUiMenuUpdate);
    emit.on("ui:drag", onUiDrag);

    return () => {
      emit.off("neovim:ui:busy", onNeovimUiBusy);
      emit.off("neovim:ui:option:set", onNeovimUiOptionSet);
      emit.off("neovim:ui:mode:change", onNeovimUiModeChange);
      emit.off("neovim:ui:tabline:update", onNeovimUiTablineUpdate);
      emit.off("neovim:ui:menu:update", onNeovimUiMenuUpdate);
      emit.off("ui:drag", onUiDrag);
    };
  }, []);

  function onNeovimUiBusy (busy: boolean) {
    setState(state => ({ ...state, busy }));
  }

  function onNeovimUiOptionSet(options: ISetting["options"]) {
    setState(state => {
      const next = { ...state.options, ...options };

      Setting.options = next;

      return { ...state, options: next };
    });
  }

  function onNeovimUiModeChange (mode: IMode) {
    setState(state => ({ ...state, mode }));
  }

  async function onNeovimUiTablineUpdate(tabs: ITab[], bufs: IBuffer[]) {
    setState(state => ({ ...state, tabs, bufs }));
  }

  function onNeovimUiMenuUpdate(menus: IMenu[]) {
    setState(state => ({ ...state, menus }));
  }

  function onUiDrag (drag: "" | number) {
    setState(state => ({ ...state, drag }));
  }

  return (
    <EditorContext.Provider value={state}>
      {children}
    </EditorContext.Provider>
  );
};
