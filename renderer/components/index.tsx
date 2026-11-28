import { createRoot } from "react-dom/client";

import "@mantine/core/styles.layer.css";
import "../styles/index.scss";

import { AppProvider } from "renderer/context/app";
import { AppComponent } from "renderer/components/app";

declare global {
  interface Window {
    envimIPC: {
      on: (event: string, callback: (...args: any[]) => void) => void,
      send: <T>(event: string, ...args: any[]) => Promise<T>,
    };
  }

  interface Navigator {
    windowControlsOverlay?: EventTarget & {
      getTitlebarAreaRect: () => DOMRect,
    };
  }
}

const element = document.getElementById("app");
element && createRoot(element).render(<AppProvider><AppComponent /></AppProvider>);
