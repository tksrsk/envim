export class WorkspaceEmit {
  constructor(private readonly workspace: string) {}

  event(base: string) {
    return `${this.workspace}:${base}`;
  }

  on(event: string, callback: (...args: any[]) => void) {
    return Emit.on(this.event(event), callback);
  }

  off(event: string, callback: (...args: any[]) => void) {
    return Emit.off(this.event(event), callback);
  }

  once(event: string, callback: (...args: any[]) => void) {
    return Emit.once(this.event(event), callback);
  }

  send<T>(event: string, ...args: any[]) {
    return Emit.send<T>(this.event(event), ...args);
  }

  share(event: string, ...args: any[]) {
    return Emit.share(this.event(event), ...args);
  }

  dispose() {
    Emit.clear(this.workspace);
  }
}

export class Emit {
  private static events: { [k: string]: ((...args: any[]) => void)[] } = {};

  static on(event: string, callback: (...args: any[]) => void) {
    if (!Emit.events[event]) {
      window.envimIPC.on(event, (...args) => Emit.share(event, ...args));
      Emit.events[event] = [];
    }

    Emit.events[event].push(callback);
  }

  static once(event: string, callback: (...args: any[]) => void) {
    const wrap = (...args: any[]) => {
      Emit.off(event, wrap);
      callback(...args);
    };

    Emit.on(event, wrap);
  }

  static share(event: string, ...args: any[]) {
    (Emit.events[event] || []).forEach(callback => callback(...args));
  }

  static send<T>(event: string, ...args: any[]): Promise<T> {
    return window.envimIPC.send<T>(event, ...args);
  }

  static off(event: string, callback: (...args: any[]) => void) {
    if (Emit.events[event]) {
      Emit.events[event] = Emit.events[event].filter(stored => callback !== stored);
    }
  }

  static clear(prefix: string) {
    window.envimIPC.clear(prefix);
  }
}
