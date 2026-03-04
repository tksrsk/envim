import React from "react";
import { createRoot } from "react-dom/client";

import "../styles/index.scss";

import { AppComponent } from "./app";

declare global {
  interface Window {
    envimIPC: {
      initialize: () => void,
      on: (event: string, callback: (...args: any[]) => void) => void,
      send: <T>(event: string, ...args: any[]) => Promise<T>,
    };
  }

  interface Navigator {
    windowControlsOverlay: {
      getTitlebarAreaRect?: () => DOMRect,
    };
  }
}

const element = document.getElementById("app");
element && createRoot(element).render(<AppComponent />);
