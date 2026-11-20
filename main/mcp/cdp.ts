import type * as Electron from "electron";

export type Send = (method: string, params?: object) => Promise<any>;

// Debugger sessions are shared by concurrent tool calls on the same guest and detached when the last one ends.
const sessions = new Map<Electron.WebContents, number>();

// Runs CDP commands on the guest through Electron's in-process debugger, without a remote debugging port.
export async function withDebugger<T>(guest: Electron.WebContents, run: (send: Send) => Promise<T>): Promise<T> {
  const count = sessions.get(guest) ?? 0;
  if (count === 0) {
    try {
      guest.debugger.attach("1.3");
    } catch (error) {
      throw new Error(`Could not control tab ${guest.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  sessions.set(guest, count + 1);

  try {
    return await run((method, params) => guest.debugger.sendCommand(method, params));
  } finally {
    const remaining = (sessions.get(guest) ?? 1) - 1;
    if (remaining > 0) {
      sessions.set(guest, remaining);
    } else {
      sessions.delete(guest);
      if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
    }
  }
}
