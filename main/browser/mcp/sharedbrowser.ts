import * as Electron from "electron";
import { addAbortListener } from "events";

const browserOwners = new WeakMap<Electron.WebContents, string>();

export function registerBrowserOwner(guest: Electron.WebContents, workspace: string | undefined): void {
  if (workspace && !browserOwners.has(guest)) browserOwners.set(guest, workspace);
}

export function webOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) return parsed.origin;
  } catch {}
  return undefined;
}

interface SharedTab {
  id: number;
  guest: Electron.WebContents;
  detach: () => void;
}

export class SharedBrowser {
  private readonly tabs = new Map<number, SharedTab>();

  constructor(private readonly workspace: string, private readonly onShareChanged: (id: number, shared: boolean) => void, private readonly onRelease?: (guest: Electron.WebContents) => void,
    private readonly openTab?: (url: string, reveal: boolean) => Promise<Electron.WebContents>,
    private readonly onShare?: (guest: Electron.WebContents) => void) {}

  async open(url: unknown, signal: AbortSignal, reveal = false): Promise<Electron.WebContents> {
    const destination = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(destination) || !webOrigin(destination)) {
      throw new Error("Provide an absolute HTTP or HTTPS URL.");
    }
    if (!this.openTab) throw new Error("The browser is unavailable.");
    signal.throwIfAborted();

    const openSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const opening = this.openTab(new URL(destination).href, reveal);
    let listener: ReturnType<typeof addAbortListener>;
    const aborted = new Promise<never>((_, reject) => {
      listener = addAbortListener(openSignal, () => reject(openSignal.reason));
    });
    try {
      const guest = await Promise.race([opening, aborted]);
      openSignal.throwIfAborted();
      this.share(guest.id);
      return guest;
    } finally {
      listener![Symbol.dispose]();
    }
  }

  share(guestId: number): void {
    const guest = Electron.webContents.fromId(guestId);
    if (!guest || !this.owns(guest)) throw new Error("The browser tab is unavailable.");
    if (!this.tabs.has(guestId)) {
      const close = () => this.revoke(guestId);
      this.tabs.set(guestId, { id: guestId, guest,
        detach: () => guest.removeListener("destroyed", close),
      });
      guest.once("destroyed", close);
      this.onShare?.(guest);
      this.onShareChanged(guestId, true);
    }
  }

  revoke(guestId?: number): void {
    for (const tab of [...this.tabs.values()]) {
      if (guestId !== undefined && tab.id !== guestId) continue;

      this.onRelease?.(tab.guest);
      this.tabs.delete(tab.id);
      tab.detach();
      this.onShareChanged(tab.id, false);
    }
  }

  owns(guest: Electron.WebContents): boolean {
    return !guest.isDestroyed() && browserOwners.get(guest) === this.workspace;
  }

  has(guestId: number): boolean {
    const tab = this.tabs.get(guestId);
    return !!tab && this.owns(tab.guest) && !!webOrigin(tab.guest.getURL());
  }

  private liveTabs(): SharedTab[] {
    return [...this.tabs.values()].filter(tab => this.owns(tab.guest) && webOrigin(tab.guest.getURL()));
  }

  guests(): Electron.WebContents[] {
    return this.liveTabs().map(tab => tab.guest);
  }
}
