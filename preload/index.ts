import * as Electron from "electron";
import { EventEmitter } from "events";

const emit = new EventEmitter;
const pending = new Set<number>();
const paused = new Set<number>();

const initialize = () => {
  pending.forEach(timer => clearTimeout(timer));
  pending.clear();
  paused.clear();
  share("envim:pause", false);
};

const on = (event: string, callback: (...args: any[]) => void) => {
  emit.on(event, callback);
  Electron.ipcRenderer.on(event, (_: Electron.IpcRendererEvent, ...args: any[]) => {
    share(event, ...args);
    share("debug", "receive", event, ...args);
  });
};

const share = (event: string, ...args: any[]) => {
  emit.emit(event, ...args);
};

const invoke = async (event: string, ...args: any[]) => {
  try {
    share("debug", "send", event, ...args);
    return await Electron.ipcRenderer.invoke(event, ...args);
  } catch (e: any) {
    if (e instanceof Error) {
      const reg = /^Error invoking remote method '[^']+': /;
      const contents = [{ hl: "red", content: e.message.replace(reg, "") }];
      share("messages:show", [{ kind: "debug", contents }], true);
    }
  }
};

const send = async (event: string, ...args: any[]) => {
  const timer = +setTimeout(() => {
    if (!pending.has(timer)) return;
    paused.add(timer);
    share("envim:pause", true);
  }, 100);
  pending.add(timer);

  try {
    return await invoke(event, ...args);
  } finally {
    clearTimeout(timer);
    pending.delete(timer);
    paused.delete(timer);
    paused.size === 0 && share("envim:pause", false);
  }
};

Electron.contextBridge.exposeInMainWorld("envimIPC", { initialize, on, send });
