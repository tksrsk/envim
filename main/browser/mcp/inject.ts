import type * as Electron from "electron";

export async function runInPage<T>(guest: Electron.WebContents, expression: string): Promise<T> {
  const code = `Promise.resolve().then(() => ${expression}).then(value => ({ ok: true, value }),
    error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))`;
  const result: { ok: true; value: T } | { ok: false; error: string } = await guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
