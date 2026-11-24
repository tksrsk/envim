import type * as Electron from "electron";

export type Send = (method: string, params?: object) => Promise<any>;

const sessions = new Map<Electron.WebContents, { users: number }>();

export function acquireDebugger(guest: Electron.WebContents) {
  const debuggerClient = guest.debugger;
  let session = sessions.get(guest);
  if (!session || !debuggerClient.isAttached()) {
    try {
      debuggerClient.attach("1.3");
    } catch (error) {
      throw new Error(`Could not control tab ${guest.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    session = { users: 0 };
    sessions.set(guest, session);
  }
  session.users++;

  let released = false;
  const send: Send = (method, params) => debuggerClient.sendCommand(method, params);
  const release = () => {
    if (released) return;
    released = true;
    if (--session.users === 0 && sessions.get(guest) === session) {
      sessions.delete(guest);
      if (!guest.isDestroyed() && debuggerClient.isAttached()) debuggerClient.detach();
    }
  };
  return { send, release };
}
