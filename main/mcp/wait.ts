import type * as Electron from "electron";

import { PageError } from "main/mcp/inject";

const LOAD_TIMEOUT = 10000;
// How long to wait after an action for a navigation it triggered to start.
const NAVIGATION_START_WINDOW = 300;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Waits until the main frame stops loading. Returns false when it is still loading after the timeout.
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

// Watches for a main-frame navigation started by an action. Call before the action, then settle after it.
export function watchNavigation(guest: Electron.WebContents) {
  let started = false;
  let notify = () => {};
  const start = new Promise<void>(resolve => { notify = resolve; });
  const onStart = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isMainFrame || event.isSameDocument) return;

    started = true;
    notify();
  };
  guest.on("did-start-navigation", onStart);
  const dispose = () => {
    if (!guest.isDestroyed()) guest.removeListener("did-start-navigation", onStart);
  };

  return {
    dispose,
    // Describes the navigation the action caused, or returns undefined when it caused none.
    async settle(): Promise<string | undefined> {
      try {
        if (!started) await Promise.race([start, delay(NAVIGATION_START_WINDOW)]);
        if (!started) return undefined;
        if (guest.isDestroyed()) return "The tab was closed.";

        return await waitForLoad(guest)
          ? `The page navigated to ${guest.getURL()}.`
          : `The page is navigating to ${guest.getURL()} and is still loading.`;
      } finally {
        dispose();
      }
    },
  };
}

// Thrown by a wait check to stop waiting. A PageError, such as an invalid selector, also stops waiting.
// Other errors from a check are retried, since they come from pages being replaced.
export class WaitAbort extends Error {}

// Polls check from the main process, so waiting continues across navigations that replace the page scripts.
export async function waitForCondition(
  guest: Electron.WebContents, timeout: number, check: () => Promise<boolean>,
): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (guest.isDestroyed()) throw new Error(`Tab ${guest.id} was closed.`);
    if (!guest.isLoadingMainFrame()) {
      try {
        // The page may be replaced while the check runs, which can leave the call pending.
        const result = await Promise.race([check(), delay(2000).then(() => false)]);
        if (result) return Date.now() - started;
      } catch (error) {
        if (error instanceof WaitAbort || error instanceof PageError) throw error;
      }
    }

    if (Date.now() - started >= timeout) throw new Error(`The condition was not met within ${timeout} ms.`);
    await delay(200);
  }
}
