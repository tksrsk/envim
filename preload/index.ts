import * as Electron from "electron";

const listeners = new Map<string, ((...args: any[]) => void)[]>();

const on = (event: string, callback: (...args: any[]) => void) => {
  const callbacks = listeners.get(event) || [];
  callbacks.push(callback);
  listeners.set(event, callbacks);
  Electron.ipcRenderer.on(event, (_: Electron.IpcRendererEvent, ...args: any[]) => {
    share(event, ...args);
    share("debug", "receive", event, ...args);
  });
};

const share = (event: string, ...args: any[]) => {
  for (const callback of [...(listeners.get(event) || [])]) {
    callback(...args);
  }
};

const send = async (event: string, ...args: any[]) => {
  try {
    share("debug", "send", event, ...args);
    return await Electron.ipcRenderer.invoke(event, ...args);
  } catch (e: any) {
    if (e instanceof Error) {
      const reg = /^Error invoking remote method '[^']+': /;
      const contents = [{ hl: "red", content: e.message.replace(reg, "") }];
      share("neovim:ui:messages:show", [{ kind: "debug", contents }], true);
    }
  }
};

Electron.contextBridge.exposeInMainWorld("envimIPC", { on, send });
