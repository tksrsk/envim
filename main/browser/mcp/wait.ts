import type * as Electron from "electron";

const LOAD_TIMEOUT = 10000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForLoad(guest: Electron.WebContents, timeout = LOAD_TIMEOUT): Promise<boolean> {
  if (guest.isDestroyed()) throw new Error(`Tab ${guest.id} was closed.`);
  if (!guest.isLoadingMainFrame()) return true;

  let cleanup = () => {};
  const stopped = new Promise<void>(resolve => {
    const done = () => resolve();
    guest.once("did-stop-loading", done);
    guest.once("destroyed", done);
    cleanup = () => {
      guest.removeListener("did-stop-loading", done);
      guest.removeListener("destroyed", done);
    };
  });
  try {
    await Promise.race([stopped, delay(timeout)]);
  } finally {
    cleanup();
  }
  if (guest.isDestroyed()) throw new Error(`Tab ${guest.id} was closed.`);
  return !guest.isLoadingMainFrame();
}

export async function waitForLoadOrThrow(guest: Electron.WebContents): Promise<void> {
  if (!await waitForLoad(guest)) throw new Error(`Tab ${guest.id} is still loading after ${LOAD_TIMEOUT / 1000} s. Try again later.`);
}
