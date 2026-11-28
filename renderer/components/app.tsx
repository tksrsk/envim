import React from "react";
import { MantineProvider } from "@mantine/core";

import { WorkspaceProvider } from "renderer/context/workspace";

import { Emit, WorkspaceEmit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { Cache } from "renderer/utils/cache";
import { theme } from "renderer/utils/theme";

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
  const overlay = navigator.windowControlsOverlay;
  const [titlebar, setTitlebar] = React.useState(() => overlay?.getTitlebarAreaRect());
  const header = {
    height: Math.max(34, titlebar?.bottom ?? 0),
    paddingLeft: (titlebar?.left ?? 0) + 6,
    paddingRight: (titlebar?.width ? Math.max(0, window.innerWidth - titlebar.right) : 0) + 6,
  };
  const main = { width: state.window.width, height: Math.max(0, state.window.height - header.height) };

  React.useEffect(() => {
    if (!overlay) return;

    const updateTitlebar = () => setTitlebar(overlay.getTitlebarAreaRect());
    overlay.addEventListener("geometrychange", updateTitlebar);
    updateTitlebar();
    return () => overlay.removeEventListener("geometrychange", updateTitlebar);
  }, [overlay]);

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
    Emit.on("console:log", console.log);
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
    <MantineProvider theme={theme} forceColorScheme={state.theme}>
      <div id="theme" className={`theme-${state.theme}`}>
        {state.init
          ? Object.entries(state.workspaces).map(([id, bookmark]) => (
            <WorkspaceProvider key={id} workspace={bookmark} workspaces={state.workspaces} active={id === state.selected} emit={new WorkspaceEmit(id)}>
              <EnvimComponent { ...{ header, main } } />
            </WorkspaceProvider>
          ))
          : <SettingComponent {...state.window} />
        }
      </div>
    </MantineProvider>
  );
}
