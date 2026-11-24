import type * as Electron from "electron";
import { isCallToolResult, type CallToolResult } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { Locator, Page } from "playwright-core";

import { Dialogs, type ActionOutcome } from "main/browser/mcp/dialogs";
import { Downloads, downloadsTool } from "main/browser/mcp/downloads";
import { runInPage } from "main/browser/mcp/inject";
import { PlaywrightWorkspace } from "main/browser/mcp/playwright";
import { isFileTool, listPlaywrightTools, playwrightToolNames } from "main/browser/mcp/playwright-tools";
import { EMPTY_TAB_PATH, MockPreview, showMockTool } from "main/browser/mcp/preview";
import { SharedBrowser, webOrigin } from "main/browser/mcp/sharedbrowser";
import { BrowserViewports, browserViewportTool } from "main/browser/mcp/viewport";
import { waitForLoadOrThrow } from "main/browser/mcp/wait";
import type { Workspace } from "main/envim/workspace";

interface BrowserTab {
  id: number;
  guest: Electron.WebContents;
}

export const BROWSER_TOOLS_SERVER_NAME = "envim-browser";

function textResult(value: unknown, isError = false): CallToolResult {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: "text", text }] };
}

export class BrowserTools {
  public readonly mock: MockPreview;
  private readonly shared: SharedBrowser;
  private readonly controller = new AbortController();
  private pending: Promise<unknown> = Promise.resolve();
  private playwrightConnection?: PlaywrightWorkspace;
  private readonly viewports: BrowserViewports;
  private readonly downloads: Downloads;
  private readonly notify: (message: string) => void;

  constructor(workspace: Workspace, private readonly origin: () => Promise<string>) {
    this.viewports = new BrowserViewports(workspace.emit, id => this.shared.has(id));
    this.notify = title => workspace.emit.update("acp:notice:changed", false, { severity: "info", title });
    this.downloads = new Downloads(this.notify, guestId => this.shared.has(guestId));
    this.shared = new SharedBrowser(workspace.id, (id, shared) => workspace.browserTabs.setShared(id, shared), guest => {
      this.playwrightConnection?.remove(guest);
      Dialogs.release(guest.id);
      void this.viewports.reset(guest);
    },
      (url, reveal) => workspace.browserTabs.open(url, reveal), guest => {
        this.downloads.watch(guest.session);
        Dialogs.claim(guest, {
          owns: () => this.shared.has(guest.id),
          onHold: dialog => this.notify(`The agent is answering ${Dialogs.describe(dialog)} in tab ${guest.id}. Stop sharing the tab to answer it yourself.`),
        });
      });
    this.mock = new MockPreview(this.shared, origin);

    workspace.emit.on("browser:viewport:get", (id: number) => {
      const guest = this.shared.guests().find(guest => guest.id === id);
      return guest ? this.viewports.get(guest) : null;
    });
    workspace.emit.on("browser:share:toggle", (guestId: number, share: boolean) => {
      if (!share) return this.shared.revoke(guestId);

      try {
        this.shared.share(guestId);
      } catch (error) {
        workspace.emit.update("acp:notice:changed", false, { severity: "warning", title: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  dispose(): void {
    this.controller.abort(new Error("The workspace browser was closed."));
    this.playwrightConnection?.close();
    this.shared.revoke();
    this.downloads.dispose();
    this.mock.html = undefined;
  }

  private static tabId(value: unknown): number | undefined {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new Error("Tab must be an integer id from browser_tabs list.");
    }
    return value;
  }

  private async playwright(signal: AbortSignal): Promise<PlaywrightWorkspace> {
    signal.throwIfAborted();
    const connection = this.playwrightConnection ??= new PlaywrightWorkspace(
      guest => !signal.aborted && this.shared.owns(guest) && this.shared.has(guest.id),
      async connectSignal => this.shared.open(`${await this.origin()}${EMPTY_TAB_PATH}`, connectSignal),
    );
    await connection.sync(this.shared.guests());
    signal.throwIfAborted();
    return connection;
  }

  private resolveTab(connection: PlaywrightWorkspace, id?: number): BrowserTab {
    const guest = id === undefined ? connection.selected : this.shared.guests().find(guest => guest.id === id);
    if (!guest || !this.shared.has(guest.id)) {
      throw new Error("No shared tab is selected. Use browser_tabs to open or select one.");
    }
    return { id: guest.id, guest };
  }

  private isAvailable(tab: BrowserTab): boolean {
    return this.shared.has(tab.id);
  }

  private async loadedTab(connection: PlaywrightWorkspace, signal: AbortSignal, id?: number): Promise<BrowserTab> {
    const tab = this.resolveTab(connection, id);
    Dialogs.assertNone(tab.guest);
    await waitForLoadOrThrow(tab.guest);
    signal.throwIfAborted();
    if (!this.isAvailable(tab)) throw new Error(`Tab ${tab.id} is no longer shared.`);
    return tab;
  }

  private async browserTabs(signal: AbortSignal, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const { action, index, url } = args;
    if (action !== "list" && action !== "new" && action !== "select") throw new Error("Choose list, new or select.");
    if (action === "select" && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
      throw new Error("Choose a tab index from browser_tabs list.");
    }
    const params = action === "new" && url !== undefined ? { action, url: BrowserTools.navigationUrl(url) } : { action, index };
    const connection = await this.playwright(signal);
    const result = await connection.callTool("browser_tabs", params);
    if (result.isError) return result;

    const ids = connection.guests.map((guest, index) => `${index}: ${guest.id}`).join(", ");
    return ids ? { ...result, content: [...result.content, { type: "text", text: `Envim tab IDs by index: ${ids}` }] } : result;
  }

  private static navigationUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    if (!/^https?:\/\//i.test(url) || !webOrigin(url)) throw new Error("Provide an absolute HTTP or HTTPS URL.");
    return url;
  }

  private async withDownloads(guest: Electron.WebContents, run: () => Promise<unknown>): Promise<unknown> {
    const { value, error, downloads } = await this.downloads.capture(guest, run);
    if (downloads.length === 0) {
      if (error !== undefined) throw error;
      return value;
    }

    const summary = Downloads.summary(downloads);
    if (isCallToolResult(value)) return { ...value, content: [...value.content, { type: "text", text: summary }] };
    return error !== undefined || typeof value !== "string" ? summary : `${value} ${summary}`;
  }

  private static report(tabId: number, outcome: ActionOutcome): unknown {
    const notes = outcome.notes.join(" ");
    if ("dialog" in outcome) {
      const dialog = `The page opened ${Dialogs.describe(outcome.dialog)} and waits for an answer. Select tab ${tabId} with browser_tabs if needed, then use browser_handle_dialog.`;
      return notes ? `${notes} ${dialog}` : dialog;
    }

    const { value } = outcome;
    if (!notes) return value;
    if (value === undefined || typeof value === "string") return [value, notes].filter(Boolean).join(" ");
    if (isCallToolResult(value)) return { ...value, content: [...value.content, { type: "text", text: notes }] };
    return typeof value === "object" && value !== null ? { ...value, notes: outcome.notes } : value;
  }

  private async act(tab: BrowserTab, run: () => Promise<unknown>): Promise<unknown> {
    return BrowserTools.report(tab.id, await Dialogs.act(tab.guest, run));
  }

  private static target(page: Page, target: unknown): Locator {
    if (typeof target !== "string" || !target.trim()) throw new Error("Provide an element reference or selector.");
    return /^(?:f\d+)?e\d+$/.test(target) ? page.getByRef(target) : page.locator(target);
  }

  private async handleDialog(signal: AbortSignal, params: Record<string, unknown> = {}): Promise<unknown> {
    if (Object.hasOwn(params, "tab")) throw new Error("Use browser_tabs to select the target tab.");
    const connection = await this.playwright(signal);
    const tab = this.resolveTab(connection);
    return this.withDownloads(tab.guest, async () => {
      const next = await Dialogs.answer(tab.guest, params.accept,
        accept => connection.answerDialog(tab.guest, accept));
      if (!this.isAvailable(tab)) throw new Error("This tab is no longer shared.");
      const answered = params.accept ? "Pressed OK." : "Pressed Cancel.";
      return next ? `${answered} ${BrowserTools.report(tab.id, { dialog: next, notes: [] })}` : answered;
    });
  }

  private async callPlaywrightTool(signal: AbortSignal, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (Object.hasOwn(args, "tab")) throw new Error("Use browser_tabs to select the target tab.");
    if (Object.hasOwn(args, "filename")) throw new Error("This tool returns its output in the response.");
    if (name === "browser_navigate") args = { ...args, url: BrowserTools.navigationUrl(args.url) };
    const connection = await this.playwright(signal);
    if (name === "browser_stop_video") {
      const result = await connection.callTool(name, args);
      if (result.isError) return result;
      const recordings = await this.downloads.registerVideos(await connection.takeVideoFiles(), signal);
      return textResult(recordings.length ? { recordings, message: "Call downloads with a recording ID to read it." } : "No videos were recorded.");
    }
    if (name === "browser_stop_recording") return connection.callTool(name, args);
    if (name === "browser_navigate" && !connection.selected) {
      const opened = await connection.callTool("browser_tabs", { action: "list" });
      if (opened.isError) return opened;
    }
    const tab = await this.loadedTab(connection, signal);
    const { guest } = tab;
    const usesPointer = name.startsWith("browser_mouse_") || name === "browser_hover" || name === "browser_drag";
    const performsInput = usesPointer || isFileTool(name) || ["browser_click", "browser_press_key", "browser_type", "browser_fill_form", "browser_select_option", "browser_evaluate"].includes(name);
    const navigates = name === "browser_navigate" || name === "browser_navigate_back";
    const hidden = (usesPointer || name === "browser_click") && await runInPage<boolean>(guest, "document.hidden");
    if (usesPointer && hidden) {
      throw new Error("Show the shared tab to use mouse input.");
    }
    const run = () => this.act(tab, async () => {
      if (name === "browser_click" && hidden) {
        const locator = BrowserTools.target(await connection.page(guest), args.target);
        if (!await locator.isEnabled({ timeout: 5000 })) throw new Error("The element is disabled.");
        const options: Parameters<Locator["click"]>[0] = {
          button: args.button as "left" | "right" | "middle" | undefined,
          modifiers: args.modifiers as NonNullable<Parameters<Locator["click"]>[0]>["modifiers"],
          force: true,
          timeout: 5000,
        };
        if (args.doubleClick === true) await locator.dblclick(options);
        else await locator.click(options);
        return "Clicked the selected element.";
      }
      return connection.callTool(name, args);
    });
    const result = performsInput || navigates ? await this.withDownloads(guest, run) : await run();
    if (!this.isAvailable(tab)) throw new Error("This tab is no longer shared.");
    return isCallToolResult(result) ? result : textResult(result);
  }

  registerTools(server: Server): void {
    server.setRequestHandler("tools/list", async () => ({
      tools: [...await listPlaywrightTools(), browserViewportTool, showMockTool, downloadsTool],
    }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      const { signal } = this.controller;
      const result = this.pending.then(() => {
        signal.throwIfAborted();
        return this.callTool(signal, params.name, params.arguments);
      });
      this.pending = result.catch(() => {});
      try {
        const response = await result;
        signal.throwIfAborted();
        return response;
      } catch (error) {
        return textResult(error instanceof Error ? error : String(error), true);
      }
    });
  }

  private async callTool(signal: AbortSignal, name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case showMockTool.name: return textResult(await this.mock.show(args?.html, signal));
      case "browser_tabs": return this.browserTabs(signal, args);
      case browserViewportTool.name: {
        const connection = await this.playwright(signal);
        const tab = await this.loadedTab(connection, signal, BrowserTools.tabId(args?.tab));
        return textResult(await this.act(tab, () => this.viewports.apply(tab.guest, args ?? {}, signal)));
      }
      case "browser_handle_dialog": {
        const result = await this.handleDialog(signal, args);
        return isCallToolResult(result) ? result : textResult(result);
      }
      case downloadsTool.name: {
        const id = args?.id;
        if (id === undefined) return textResult(this.downloads.list());
        if (typeof id !== "string") return textResult("Id must be a download id such as d1.", true);
        return { content: await this.downloads.read(id, args?.offset) };
      }
      default:
        return playwrightToolNames.has(name) ? this.callPlaywrightTool(signal, name, args ?? {}) :
          textResult(`Unknown tool: ${name}`, true);
    }
  }
}
