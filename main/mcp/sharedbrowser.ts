import * as Electron from "electron";
import { randomUUID } from "crypto";
import type { WorkspaceEmit } from "main/emit";
import { waitForLoadOrThrow } from "main/mcp/wait";

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
  // Tabs being opened by navigate, keyed by request id.
  private readonly opening = new Map<string, (guestId?: number) => void>();

  constructor(private readonly emit: WorkspaceEmit, private readonly onRevoke?: (guest: Electron.WebContents) => void,
    private readonly openTab?: (url: string, requestId: string) => Promise<void>,
    private readonly onShare?: (guest: Electron.WebContents) => void) {}

  attach(requestId: string, guestId: number): void {
    this.opening.get(requestId)?.(guestId);
  }

  private async open(url: string): Promise<SharedTab> {
    if (!this.openTab) throw new Error("The browser is unavailable.");

    const id = randomUUID();
    let ready!: (guestId?: number) => void;
    const attached = new Promise<number | undefined>(resolve => { ready = resolve; });
    this.opening.set(id, ready);
    const timer = setTimeout(ready, 15000);
    try {
      const guestId = await Promise.race([
        attached,
        this.openTab(url, id).then(() => attached),
      ]);
      if (guestId === undefined || this.opening.get(id) !== ready) {
        throw new Error("The new browser tab did not finish opening for sharing.");
      }

      this.opening.delete(id);
      this.share(guestId);
      return this.tabs.get(guestId)!;
    } finally {
      clearTimeout(timer);
      if (this.opening.get(id) === ready) this.opening.delete(id);
    }
  }

  share(guestId: number): string {
    const guest = Electron.webContents.fromId(guestId);
    const origin = guest?.getType() === "webview" ? webOrigin(guest.getURL()) : undefined;
    if (!guest || !origin) throw new Error("Open an HTTP or HTTPS page before sharing its tab.");
    if (this.tabs.has(guestId)) return guest.getURL();

    const close = () => this.revoke(guestId);
    const navigate = (event: Electron.WebContentsDidStartNavigationEventParams) => {
      if (event.isMainFrame && !webOrigin(event.url)) close();
    };
    const navigated = () => {
      if (!webOrigin(guest.getURL())) close();
    };
    this.tabs.set(guestId, { id: guestId, guest, detach: () => {
      guest.removeListener("destroyed", close);
      guest.removeListener("did-start-navigation", navigate);
      guest.removeListener("did-navigate", navigated);
    } });
    guest.once("destroyed", close);
    guest.on("did-start-navigation", navigate);
    guest.on("did-navigate", navigated);
    this.onShare?.(guest);
    this.emit.send("browser:share:status", guestId, true);
    return guest.getURL();
  }

  // Revokes one tab, or every tab and pending open when guestId is omitted.
  revoke(guestId?: number): void {
    if (guestId === undefined) {
      for (const [id, ready] of [...this.opening]) {
        this.opening.delete(id);
        ready();
      }
    }

    for (const tab of [...this.tabs.values()]) {
      if (guestId !== undefined && tab.id !== guestId) continue;

      this.tabs.delete(tab.id);
      tab.detach();
      this.onRevoke?.(tab.guest);
      this.emit.send("browser:share:status", tab.id, false);
    }
  }

  has(guestId: number): boolean {
    return this.tabs.has(guestId);
  }

  private liveTabs(): SharedTab[] {
    return [...this.tabs.values()].filter(tab => !tab.guest.isDestroyed() && webOrigin(tab.guest.getURL()));
  }

  guests(): Electron.WebContents[] {
    return this.liveTabs().map(tab => tab.guest);
  }

  // Returns the shared guest with the id, or the only shared guest when guestId is omitted.
  guest(guestId?: number): Electron.WebContents | undefined {
    const tabs = this.liveTabs();
    if (guestId === undefined) return tabs.length === 1 ? tabs[0].guest : undefined;

    return tabs.find(tab => tab.id === guestId)?.guest;
  }

  private resolve(tabId: number | undefined): SharedTab {
    const tabs = this.liveTabs();
    if (tabs.length === 0) throw new Error("No web tab is shared with this session. Use Share tab in the browser toolbar.");
    if (tabId === undefined) {
      if (tabs.length > 1) throw new Error("Several tabs are shared with this session. Pass tab with an id from use_tab list.");
      return tabs[0];
    }

    const tab = tabs.find(tab => tab.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} is not shared with this session. Use use_tab list to see the available tabs.`);
    return tab;
  }

  private isShared(tab: SharedTab): boolean {
    return this.tabs.get(tab.id) === tab && this.guest(tab.id) === tab.guest;
  }

  // Loads url in the shared tab, or opens and shares a new tab when newTab is true or nothing is shared yet.
  async navigate(url: unknown, tabId: number | undefined, newTab: unknown): Promise<string> {
    const target = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(target) || !webOrigin(target)) {
      throw new Error("Provide an absolute HTTP or HTTPS URL.");
    }

    const destination = new URL(target).href;
    if (newTab === true || (tabId === undefined && this.liveTabs().length === 0)) {
      const opened = await this.open(destination);
      return `Opened ${opened.guest.getURL()} in new shared tab ${opened.id}.`;
    }

    const tab = this.resolve(tabId);
    await waitForLoadOrThrow(tab.guest);
    await tab.guest.loadURL(destination);
    if (!this.isShared(tab)) throw new Error(`Tab ${tab.id} is no longer shared.`);
    return `Opened ${tab.guest.getURL()} in shared tab ${tab.id}.`;
  }
}
