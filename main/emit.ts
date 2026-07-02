import * as Electron from "electron";
import { EventEmitter } from "events";

import { Bootstrap } from "main/bootstrap";

export class WorkspaceEmit {
  constructor(private readonly workspace: string) {}

  event(base: string) {
    return `${this.workspace}:${base}`;
  }

  send(event: string, ...args: any[]) {
    return Emit.send(this.event(event), ...args);
  }

  update(event: string, async: boolean, ...args: any[]) {
    return Emit.update(this.event(event), async, ...args);
  }

  on(event: string, callback: (...args: any[]) => unknown) {
    return Emit.on(this.event(event), callback);
  }

  off(event: string) {
    return Emit.off(this.event(event));
  }

  share(event: string, ...args: any[]) {
    return Emit.share(this.event(event), ...args);
  }

  dispose() {
    Emit.offByPrefix(this.workspace);
  }
}

export class Emit {
  private static emit = new EventEmitter;
  private static events: { [k: string]: ((...args: any[]) => unknown)[] } = {};
  private static cache: { [k: string ]: { json: string; timer: number; } } = {};

  static on(event: string, callback: (...args: any[]) => unknown) {
    if (!Emit.events[event]) {
      Electron.ipcMain.handle(event, (_: Electron.IpcMainInvokeEvent, ...args: any[]) => Emit.share(event, ...args));
      Emit.emit.on(event, (...args) => Emit.share(event, ...args));
      Emit.events[event] = [];
    }

    Emit.events[event].push(callback);
  }

  static async share(event: string, ...args: any[]) {
    return Emit.events[event]
      .map(callback => callback(...args))
      .find(result => result);
  }

  static send(event: string, ...args: any[]) {
    Bootstrap.win?.webContents.send(event, ...args);
  }

  static update(event: string, async: boolean, ...args: any[]) {
    const json = JSON.stringify(args);
    const cache = Emit.cache[event] || { json: "", timer: 0 };

    if (cache.json !== json) {
      cache.json = json;
      cache.timer || Emit.send(event, ...args);

      if (async && cache.timer === 0) {
        cache.timer = +setTimeout(() => {
          cache.timer = 0;
          cache.json === json || Emit.send(event, ...JSON.parse(cache.json));
        }, 200);
      }

      Emit.cache[event] = cache;
    }
  }

  static off(event: string) {
    Emit.events[event] = [];
  }

  static offByPrefix(prefix: string) {
    for (const event of Object.keys(Emit.events)) {
      if (event.startsWith(`${prefix}:`)) {
        Emit.events[event] = [];
      }
    }
  }
}
