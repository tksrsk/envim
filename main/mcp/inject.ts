import type * as Electron from "electron";

// An error thrown by code running in the page, with the page's message.
export class PageError extends Error {}

// Evaluates expression in the guest's isolated world and returns its value, awaiting promises. Errors
// thrown by the expression are caught in the page and rethrown here as PageError: otherwise Electron
// replaces their message with a generic one and the page logs them as uncaught errors.
export async function runInPage<T>(guest: Electron.WebContents, expression: string): Promise<T> {
  const code = `Promise.resolve().then(() => ${expression}).then(value => ({ ok: true, value }),
    error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))`;
  const result: { ok: true; value: T } | { ok: false; error: string } = await guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  if (!result.ok) throw new PageError(result.error);
  return result.value;
}
