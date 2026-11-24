import React from "react";

import type { IWorkspaceBrowserState } from "common/interface";
import { useWorkspace } from "renderer/context/workspace";

export function useBrowserWorkspace() {
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<IWorkspaceBrowserState>({ tabs: [] });
  React.useEffect(() => {
    let listening = true;
    let receivedUpdate = false;

    function onBrowserTabsChanged(value: IWorkspaceBrowserState) {
      receivedUpdate = true;
      setState(value);
    }

    emit.on("browser:tabs:changed", onBrowserTabsChanged);
    void emit.send<IWorkspaceBrowserState>("browser:tabs:get").then(value => {
      if (listening && !receivedUpdate && value) setState(value);
    });
    return () => {
      listening = false;
      emit.off("browser:tabs:changed", onBrowserTabsChanged);
    };
  }, [emit.workspaceId]);
  return { ...state, current: state.tabs.find(tab => tab.id === state.selected) };
}

export type BrowserWorkspace = ReturnType<typeof useBrowserWorkspace>;
