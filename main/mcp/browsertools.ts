import type * as Electron from "electron";
import type { Server } from "@modelcontextprotocol/server";

import type { IBrowserElement } from "common/interface";

import { refToSelector, snapshotTab } from "main/mcp/axtree";
import { captureGuest, screenshotTool, type Screenshot } from "main/mcp/capture";
import { Dialogs, handleDialogTool, type ActionOutcome } from "main/mcp/dialogs";
import { Downloads, downloadsTool, type DownloadContent } from "main/mcp/downloads";
import { MockPreview, showMockTool } from "main/mcp/preview";
import { SharedBrowser, webOrigin } from "main/mcp/sharedbrowser";
import { isPicking, pickElement, stopPicking } from "main/mcp/picker";
import { goInHistory, runTabAction, summarizeTab, useTabTool, waitInTab, type BrowserTab } from "main/mcp/tabs";
import { waitForLoadOrThrow } from "main/mcp/wait";
import { readLogsTool, TabLogs } from "main/mcp/tablog";
import type { Workspace } from "main/envim/workspace";

export const BROWSER_TOOLS_SERVER_NAME = "envim-browser";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | DownloadContent;
type ToolResult = { isError?: true; content: ToolContent[] };

function textResult(value: unknown, isError = false): ToolResult {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: "text", text }] };
}

// Images go with a text summary so agents that drop image content still get a usable result.
function imageResult({ image, summary }: Screenshot): ToolResult {
  return { content: [{ type: "image", ...image }, { type: "text", text: JSON.stringify(summary) }] };
}

// Browser tools of a workspace, for the agent connected to it: the tabs the user shared with it, the mock
// preview shown in one, actions and screenshots and logs on them, and element picking.
export class BrowserTools {
  public readonly mock: MockPreview;
  private readonly shared: SharedBrowser;
  private readonly downloads: Downloads;
  private readonly notify: (message: string) => void;

  // origin returns the origin of the browser server that serves the mock preview.
  constructor(workspace: Workspace, origin: () => Promise<string>) {
    this.notify = message => workspace.emit.send("acp:browser:notice", message);
    this.downloads = new Downloads(this.notify, guestId => this.shared.has(guestId));
    this.shared = new SharedBrowser(workspace.emit, guest => {
      stopPicking(guest);
      // A dialog the agent has not answered goes to the user.
      Dialogs.release(guest.id);
    },
      (url, requestId) => workspace.showBrowserTab(url, requestId), guest => this.downloads.watch(guest.session));
    this.mock = new MockPreview(this.shared, origin);
  }

  // Forgets the shared tabs, mock preview and downloads of the agent that has gone.
  reset(): void {
    this.shared.revoke();
    this.downloads.reset();
    this.mock.html = undefined;
  }

  attachSharedTab(requestId: string, guestId: number): void {
    this.shared.attach(requestId, guestId);
  }

  shareTab(guestId: number): string {
    return this.shared.share(guestId);
  }

  // Revokes one shared tab, or all of them when guestId is omitted.
  revokeTabs(guestId?: number): void {
    this.shared.revoke(guestId);
  }

  // Stops the element picker in one tab, or in every shared tab when guestId is omitted.
  stopPicking(guestId?: number): void {
    for (const guest of this.shared.guests()) {
      if (guestId === undefined || guest.id === guestId) stopPicking(guest);
    }
  }

  async pick(guestId: number, onSelection: (selection: IBrowserElement) => void): Promise<void> {
    const guest = this.shared.guest(guestId);
    if (!guest) throw new Error("Share this tab with the active ACP session before selecting an element.");

    await pickElement(guest, () => this.shared.guest(guestId) === guest, selection => {
      onSelection({ ...selection, url: guest.getURL(), tab: guestId });
    });
  }

  // The shared tabs.
  private tabs(): BrowserTab[] {
    return this.shared.guests().flatMap(guest => {
      const origin = webOrigin(guest.getURL());
      return origin ? [{ id: guest.id, guest, scope: `${origin}/` }] : [];
    });
  }

  private static tabId(value: unknown): number | undefined {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new Error("Tab must be an integer id from use_tab list.");
    }
    return value;
  }

  // Returns the tab with the id, or the only tab when id is omitted.
  private resolveTab(id: number | undefined): BrowserTab {
    const tabs = this.tabs();
    if (tabs.length === 0) throw new Error("No tab is available. Ask the user to share a web tab, or call show_mock first.");
    if (id === undefined) {
      if (tabs.length > 1) throw new Error(`Several tabs are available (${tabs.map(tab => tab.id).join(", ")}). Pass tab with one of these ids.`);
      return tabs[0];
    }

    const tab = tabs.find(tab => tab.id === id);
    if (!tab) throw new Error(`Tab ${id} is not available to this session. Use use_tab list to see the available tabs.`);
    return tab;
  }

  // The tab as it is now, with a scope that follows the current page, or undefined when it is no longer available.
  private current(tab: BrowserTab): BrowserTab | undefined {
    return this.tabs().find(current => current.guest === tab.guest);
  }

  private isAvailable(tab: BrowserTab): boolean {
    return this.current(tab) !== undefined;
  }

  // Resolves the tab after any page it is loading has finished, so the scope matches the loaded page.
  private async loadedTab(id: number | undefined): Promise<BrowserTab> {
    const tab = this.resolveTab(id);
    // A page blocked by a dialog does not finish loading.
    Dialogs.assertNone(tab.guest);
    await waitForLoadOrThrow(tab.guest);
    const loaded = this.current(tab);
    if (!loaded) throw new Error(`Tab ${tab.id} is no longer available to this session.`);
    return loaded;
  }

  // Replaces a ref in params with the selector of its element as the page is now.
  private static async withSelector(tab: BrowserTab, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { ref, selector } = params;
    if (ref === undefined) return params;
    if (selector !== undefined) throw new Error("Pass either ref or selector, not both.");
    if (typeof ref !== "string" || !/^e\d+$/.test(ref)) throw new Error("Ref must be a value such as e12 from inspect.");

    return { ...params, selector: await refToSelector(tab.guest, ref) };
  }

  // Runs an action that can start downloads in the tab, and reports them with its result. A failed
  // action that downloaded a file, such as a navigation that became a download, reports the download.
  private async withDownloads(guest: Electron.WebContents, run: () => Promise<unknown>): Promise<unknown> {
    const { value, error, downloads } = await this.downloads.capture(guest, run);
    if (downloads.length === 0) {
      if (error !== undefined) throw error;
      return value;
    }

    const summary = Downloads.summary(downloads);
    return error !== undefined || typeof value !== "string" ? summary : `${value} ${summary}`;
  }

  // Describes an action's outcome for the agent: its result with what the page did on its own, or the
  // dialog the action opened that waits for an answer.
  private static report(tabId: number, outcome: ActionOutcome): unknown {
    const notes = outcome.notes.join(" ");
    if ("dialog" in outcome) {
      const dialog = `The page opened ${Dialogs.describe(outcome.dialog)} and waits for an answer. Answer it with handle_dialog on tab ${tabId}.`;
      return notes ? `${notes} ${dialog}` : dialog;
    }

    const { value } = outcome;
    if (!notes) return value;
    if (value === undefined || typeof value === "string") return [value, notes].filter(Boolean).join(" ");
    return typeof value === "object" && value !== null ? { ...value, notes: outcome.notes } : value;
  }

  // Runs an agent action, so dialogs it opens are held for the agent instead of blocking the action.
  private async act(tab: { id: number; guest: Electron.WebContents }, run: () => Promise<unknown>): Promise<unknown> {
    const outcome = await Dialogs.act(tab.guest, run);
    if ("dialog" in outcome) {
      this.notify(`The agent is answering ${Dialogs.describe(outcome.dialog)} in tab ${tab.id}. Stop sharing the tab to answer it yourself.`);
    }
    return BrowserTools.report(tab.id, outcome);
  }

  private async useTab(params: Record<string, unknown> = {}): Promise<unknown> {
    const id = BrowserTools.tabId(params.tab);
    if (params.action === "list") return this.tabs().map(summarizeTab);

    if (params.action === "navigate") {
      const guest = params.new_tab === true ? undefined : this.shared.guest(id);
      const navigate = () => this.shared.navigate(params.url, id, params.new_tab);
      return guest ? this.withDownloads(guest, () => this.act({ id: guest.id, guest }, navigate)) : navigate();
    }

    if (params.action === "wait") {
      const tab = this.resolveTab(id);
      Dialogs.assertNone(tab.guest);
      const resolved = await BrowserTools.withSelector(tab, params);
      return this.act(tab, () => waitInTab(tab, resolved, () => this.current(tab)));
    }

    const tab = await this.loadedTab(id);
    if (params.action === "back" || params.action === "forward") {
      const direction = params.action;
      return this.withDownloads(tab.guest, () => this.act(tab, () => goInHistory(tab, direction)));
    }

    if (params.action !== "inspect") {
      // The element picker takes trusted clicks as the user's selection.
      if ((params.action === "click" || params.action === "check") && isPicking(tab.guest)) {
        throw new Error(`The user is selecting an element in tab ${tab.id}. Try again after the selection ends.`);
      }
      const resolved = await BrowserTools.withSelector(tab, params);
      const run = () => this.act(tab, () => runTabAction(tab, resolved));
      return params.action === "scroll" ? run() : this.withDownloads(tab.guest, run);
    }

    const url = tab.guest.getURL();
    const snapshot = await snapshotTab(tab.guest);
    // Page data is returned only while the tab is still available to this session and on the same page.
    if (!this.isAvailable(tab) || tab.guest.getURL() !== url) {
      throw new Error(`Tab ${tab.id} changed while it was inspected. Try again.`);
    }
    return { ...summarizeTab(tab), ...snapshot };
  }

  private async handleDialog(params: Record<string, unknown> = {}): Promise<unknown> {
    const tab = this.resolveTab(BrowserTools.tabId(params.tab));
    return this.withDownloads(tab.guest, async () => {
      const outcome = await Dialogs.answer(tab.guest, params.accept);
      const answered = params.accept ? "Pressed OK." : "Pressed Cancel.";
      const report = BrowserTools.report(tab.id, outcome);
      if (report === undefined || typeof report === "string") return [answered, report].filter(Boolean).join(" ");
      return typeof report === "object" && report !== null ? { answered, ...report } : report;
    });
  }

  private async screenshot(params: Record<string, unknown> = {}): Promise<Screenshot> {
    const tab = await this.loadedTab(BrowserTools.tabId(params.tab));
    const { selector } = await BrowserTools.withSelector(tab, params);
    if (selector !== undefined && typeof selector !== "string") throw new Error("Selector must be a string.");

    return captureGuest(tab.guest, selector, () => this.isAvailable(tab));
  }

  private readLogs(params: Record<string, unknown> = {}) {
    const tab = this.resolveTab(BrowserTools.tabId(params.tab));
    return { tab: tab.id, ...TabLogs.read(tab.id, params) };
  }

  registerTools(server: Server): void {
    server.setRequestHandler("tools/list", () => ({ tools: [showMockTool, useTabTool, screenshotTool, readLogsTool, downloadsTool, handleDialogTool] }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      try {
        switch (params.name) {
          case showMockTool.name: return textResult(await this.mock.show(params.arguments?.html));
          case useTabTool.name: return textResult(await this.useTab(params.arguments));
          case handleDialogTool.name: return textResult(await this.handleDialog(params.arguments));
          case downloadsTool.name: {
            const id = params.arguments?.id;
            if (id === undefined) return textResult(this.downloads.list());
            if (typeof id !== "string") return textResult("Id must be a download id such as d1.", true);
            return { content: await this.downloads.read(id) };
          }
          case readLogsTool.name: return textResult(this.readLogs(params.arguments));
          case screenshotTool.name: return imageResult(await this.screenshot(params.arguments));
          default: return textResult(`Unknown tool: ${params.name}`, true);
        }
      } catch (error) {
        return textResult(error instanceof Error ? error : String(error), true);
      }
    });
  }
}
