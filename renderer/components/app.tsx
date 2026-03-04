import React, { useEffect, useState } from "react";

import { Emit } from "../utils/emit";
import { Setting } from "../utils/setting";
import { Highlights } from "../utils/highlight";
import { Cache } from "../utils/cache";
import { y2Row, x2Col, row2Y, col2X } from "../utils/size";

import { SettingComponent } from "./setting";
import { EnvimComponent } from "./envim";

interface States {
  init: boolean;
  theme: "dark" | "light";
  window: { width: number; height: number; };
}

export function AppComponent() {
  const [state, setState] = useState<States>({ init: false, theme: "dark", window: { width: window.innerWidth, height: window.innerHeight } });
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

  useEffect(() => {
    document.fonts.load("10px Regular").then();
    document.fonts.load("10px Bold").then();
    document.fonts.load("10px Alt").then();
    document.fonts.load("10px Alt Bold").then();
    document.fonts.load("10px Icon").then();
    document.fonts.load("10px Git").then();
    Emit.on("app:resize", onResize);
    Emit.on("app:switch", onSwitch);
    Emit.on("app:theme", onTheme);
    Highlights.setHighlight("0", true, {  });
  }, []);

  function onResize (width: number, height: number) {
    setState(state => ({ ...state, window: { width, height } }));
  }

  function onSwitch (init: boolean) {
    setState(state => {
      Emit.initialize();

      state.init === init || Emit.send("envim:setting", Setting.get());

      return { ...state, init };
    });
  }

  function onTheme (theme: "dark" | "light") {
    setState(state => ({ ...state, theme }));
    Cache.set<"dark" | "light">("common", "theme", theme);
  }

  return (
    <div className={`theme-${state.theme}`}>
      {state.init
        ? <EnvimComponent { ...{ header, main, footer } } />
        : <SettingComponent {...state.window} />
      }
    </div>
  );
}
