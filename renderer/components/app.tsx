import React from "react";

import { WorkspaceProvider } from "renderer/context/workspace";

import { Emit, WorkspaceEmit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { Cache } from "renderer/utils/cache";
import { y2Row, x2Col, row2Y, col2X } from "renderer/utils/size";

import { SettingComponent } from "renderer/components/setting";
import { EnvimComponent } from "renderer/components/envim";

interface States {
  init: boolean;
  theme: "dark" | "light";
  window: { width: number; height: number; };
  workspaces: { [id: string]: string };
  selected: string;
}

export function AppComponent() {
  const [state, setState] = React.useState<States>({ init: false, theme: "dark", window: { width: window.innerWidth, height: window.innerHeight }, workspaces: {}, selected: "" });
  const titlebar = navigator.windowControlsOverlay.getTitlebarAreaRect
    ? navigator.windowControlsOverlay.getTitlebarAreaRect()
    : { x: 0, y: 0, width: 0, height: 0, left: 0, right: 0 };
  const header = {
    width: titlebar.width + titlebar.left,
    height: Math.max(row2Y(2), (titlebar.y * 2) + titlebar.height),
    paddingLeft: titlebar.left || 0,
  };
  const main = {
    width: col2X(x2Col(state.window.width) - 2),
    height: row2Y(y2Row(state.window.height - header.height - row2Y(1) - 4) - 1),
  };
  const footer = { width: state.window.width, height: state.window.height - header.height - main.height - row2Y(1) };

  React.useEffect(() => {
    document.fonts.load("10px Regular").then();
    document.fonts.load("10px Bold").then();
    document.fonts.load("10px Alt").then();
    document.fonts.load("10px Alt Bold").then();
    document.fonts.load("10px Icon").then();
    document.fonts.load("10px Git").then();
    Emit.on("app:resize", onAppResize);
    Emit.on("app:theme", onAppTheme);
    Emit.on("app:workspace", onAppWorkspace);
  }, []);

  function onAppResize (width: number, height: number) {
    setState(state => ({ ...state, window: { width, height } }));
  }

  function onAppTheme (theme: "dark" | "light") {
    setState(state => ({ ...state, theme }));
    Cache.set<"dark" | "light">("common", "theme", theme);
  }

  function onAppWorkspace(workspaces: { [id: string]: string }, selected: string) {
    const init = Object.keys(workspaces).length > 0;

    init || Emit.send("app:setting", Setting.get());
    setState(state => ({ ...state, workspaces, selected, init }));
  }

  return (
    <div className={`theme-${state.theme}`}>
      {state.init
        ? Object.entries(state.workspaces).map(([id, bookmark]) => (
          <WorkspaceProvider key={id} workspace={bookmark} workspaces={state.workspaces} active={id === state.selected} emit={new WorkspaceEmit(id)}>
            <EnvimComponent { ...{ header, main, footer } } />
          </WorkspaceProvider>
        ))
        : <SettingComponent {...state.window} />
      }
    </div>
  );
}
