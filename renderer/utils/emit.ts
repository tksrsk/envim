export class Emit {
  private static events: { [k: string]: ((...args: any[]) => void)[] } = {};

  static initialize() {
    window.envimIPC.initialize();
  }

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
}
