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

interface OpeningTab {
  endpoint: string;
  ready: (guestId?: number) => void;
}

export class SharedBrowser {
  // Shared tabs per endpoint, keyed by guest id. A guest is shared with at most one endpoint.
  private readonly tabs = new Map<string, Map<number, SharedTab>>();
  // Tabs being opened by navigate, keyed by request id.
  private readonly opening = new Map<string, OpeningTab>();

  constructor(private readonly emit: WorkspaceEmit, private readonly onRevoke?: (endpoint: string, guestId: number) => void,
    private readonly openTab?: (url: string, requestId: string) => Promise<void>) {}

  attach(requestId: string, guestId: number): void {
    this.opening.get(requestId)?.ready(guestId);
  }

  private async open(endpoint: string, url: string): Promise<SharedTab> {
    if (!this.openTab) throw new Error("The browser is unavailable.");

    const id = randomUUID();
    let ready!: (guestId?: number) => void;
    const attached = new Promise<number | undefined>(resolve => { ready = resolve; });
    const request = { endpoint, ready };
    this.opening.set(id, request);
    const timer = setTimeout(ready, 15000);
    try {
      const guestId = await Promise.race([
        attached,
        this.openTab(url, id).then(() => attached),
      ]);
      if (guestId === undefined || this.opening.get(id) !== request) {
        throw new Error("The new browser tab did not finish opening for sharing.");
      }

      this.opening.delete(id);
      this.share(endpoint, guestId);
      return this.tabs.get(endpoint)!.get(guestId)!;
    } finally {
      clearTimeout(timer);
      if (this.opening.get(id) === request) this.opening.delete(id);
    }
  }

  share(endpoint: string, guestId: number): string {
    const guest = Electron.webContents.fromId(guestId);
    const origin = guest?.getType() === "webview" ? webOrigin(guest.getURL()) : undefined;
    if (!guest || !origin) throw new Error("Open an HTTP or HTTPS page before sharing its tab.");
    if (this.tabs.get(endpoint)?.has(guestId)) return guest.getURL();

    this.revokeGuest(guestId);
    const close = () => this.revoke(endpoint, guestId);
    const navigate = (event: Electron.WebContentsDidStartNavigationEventParams) => {
      if (event.isMainFrame && !webOrigin(event.url)) close();
    };
    const navigated = () => {
      if (!webOrigin(guest.getURL())) close();
    };
    const tabs = this.tabs.get(endpoint) ?? new Map<number, SharedTab>();
    this.tabs.set(endpoint, tabs);
    tabs.set(guestId, { id: guestId, guest, detach: () => {
      guest.removeListener("destroyed", close);
      guest.removeListener("did-start-navigation", navigate);
      guest.removeListener("did-navigate", navigated);
    } });
    guest.once("destroyed", close);
    guest.on("did-start-navigation", navigate);
    guest.on("did-navigate", navigated);
    this.emit.send("browser:share:status", guestId, true);
    return guest.getURL();
  }

  // Revokes one tab, or every tab and pending open of the endpoint when guestId is omitted.
  revoke(endpoint: string, guestId?: number): void {
    if (guestId === undefined) {
      for (const [id, request] of [...this.opening]) {
        if (request.endpoint !== endpoint) continue;

        this.opening.delete(id);
        request.ready();
      }
    }

    const tabs = this.tabs.get(endpoint);
    for (const tab of [...(tabs?.values() ?? [])]) {
      if (guestId !== undefined && tab.id !== guestId) continue;

      tabs!.delete(tab.id);
      tab.detach();
      this.onRevoke?.(endpoint, tab.id);
      this.emit.send("browser:share:status", tab.id, false);
    }
    if (tabs?.size === 0) this.tabs.delete(endpoint);
  }

  // Revokes the tab from whichever session it is shared with, including inactive sessions.
  revokeGuest(guestId: number): void {
    for (const [endpoint, tabs] of [...this.tabs]) {
      if (tabs.has(guestId)) this.revoke(endpoint, guestId);
    }
  }

  private liveTabs(endpoint: string): SharedTab[] {
    return [...(this.tabs.get(endpoint)?.values() ?? [])]
      .filter(tab => !tab.guest.isDestroyed() && webOrigin(tab.guest.getURL()));
  }

  guests(endpoint: string): Electron.WebContents[] {
    return this.liveTabs(endpoint).map(tab => tab.guest);
  }

  // Returns the shared guest with the id, or the only shared guest when guestId is omitted.
  guest(endpoint: string, guestId?: number): Electron.WebContents | undefined {
    const tabs = this.liveTabs(endpoint);
    if (guestId === undefined) return tabs.length === 1 ? tabs[0].guest : undefined;

    return tabs.find(tab => tab.id === guestId)?.guest;
  }

  private resolve(endpoint: string, tabId: number | undefined): SharedTab {
    const tabs = this.liveTabs(endpoint);
    if (tabs.length === 0) throw new Error("No web tab is shared with this session. Use Share tab in the browser toolbar.");
    if (tabId === undefined) {
      if (tabs.length > 1) throw new Error("Several tabs are shared with this session. Pass tab with an id from use_tab list.");
      return tabs[0];
    }

    const tab = tabs.find(tab => tab.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} is not shared with this session. Use use_tab list to see the available tabs.`);
    return tab;
  }

  private isShared(endpoint: string, tab: SharedTab): boolean {
    return this.tabs.get(endpoint)?.get(tab.id) === tab && this.guest(endpoint, tab.id) === tab.guest;
  }

  // Loads url in the shared tab, or opens and shares a new tab when newTab is true or nothing is shared yet.
  async navigate(endpoint: string, url: unknown, tabId: number | undefined, newTab: unknown): Promise<string> {
    const target = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(target) || !webOrigin(target)) {
      throw new Error("Provide an absolute HTTP or HTTPS URL.");
    }

    const destination = new URL(target).href;
    if (newTab === true || (tabId === undefined && this.liveTabs(endpoint).length === 0)) {
      const opened = await this.open(endpoint, destination);
      return `Opened ${opened.guest.getURL()} in new shared tab ${opened.id}.`;
    }

    const tab = this.resolve(endpoint, tabId);
    await waitForLoadOrThrow(tab.guest);
    await tab.guest.loadURL(destination);
    if (!this.isShared(endpoint, tab)) throw new Error(`Tab ${tab.id} is no longer shared.`);
    return `Opened ${tab.guest.getURL()} in shared tab ${tab.id}.`;
  }
}
