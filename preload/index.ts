import * as Electron from "electron";

const listeners = new Map<string, ((...args: any[]) => void)[]>();
const pending = new Map<number, string>();
const paused = new Map<number, string>();

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

const invoke = async (event: string, ...args: any[]) => {
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

const release = (timer: number) => {
  clearTimeout(timer);
  pending.delete(timer);
  paused.delete(timer);
  paused.size === 0 && share("app:pause", false);
};

const send = async (event: string, ...args: any[]) => {
  const timer = +setTimeout(() => {
    if (!pending.has(timer)) return;
    paused.set(timer, event);
    share("app:pause", true);
  }, 100);
  pending.set(timer, event);

  try {
    return await invoke(event, ...args);
  } finally {
    release(timer);
  }
};

const clear = (prefix: string) => {
  for (const [timer, event] of pending) {
    event.startsWith(`${prefix}:`) && release(timer);
  }
};

Electron.contextBridge.exposeInMainWorld("envimIPC", { on, send, clear });
