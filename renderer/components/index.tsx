import { createRoot } from "react-dom/client";

import "../styles/index.scss";

import { AppComponent } from "renderer/components/app";

declare global {
  interface Window {
    envimIPC: {
      on: (event: string, callback: (...args: any[]) => void) => void,
      send: <T>(event: string, ...args: any[]) => Promise<T>,
      clear: (prefix: string) => void,
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
