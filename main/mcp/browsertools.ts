import type { Server } from "@modelcontextprotocol/server";

import type { IBrowserElement } from "common/interface";

import { captureGuest, screenshotTool, type Screenshot } from "main/mcp/capture";
import { MockPreview, showMockTool } from "main/mcp/preview";
import { SharedBrowser, webOrigin } from "main/mcp/sharedbrowser";
import { pickElement, stopPicking } from "main/mcp/picker";
import { runTabAction, summarizeTab, useTabTool, type BrowserTab } from "main/mcp/tabs";
import { readLogsTool, TabLogs } from "main/mcp/tablog";
import type { Workspace } from "main/envim/workspace";

export const BROWSER_TOOLS_SERVER_NAME = "envim-browser";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { isError?: true; content: ToolContent[] };

function textResult(value: unknown, isError = false): ToolResult {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: "text", text }] };
}

// Images go with a text summary so agents that drop image content still get a usable result.
function imageResult({ image, summary }: Screenshot): ToolResult {
  return { content: [{ type: "image", ...image }, { type: "text", text: JSON.stringify(summary) }] };
}

// Browser tools exposed to one ACP session: the mock preview, the shared HTTP(S) tabs, actions and
// screenshots and logs on either kind of tab, and element picking.
export class BrowserTools {
  private readonly mock: MockPreview;
  private readonly shared: SharedBrowser;

  constructor(workspace: Workspace, private readonly onRemove?: (endpoint: string) => void) {
    this.mock = new MockPreview(workspace);
    this.shared = new SharedBrowser(workspace.emit, (endpoint, guestId) => stopPicking(endpoint, guestId),
      (url, requestId) => workspace.showBrowserTab(url, requestId));
  }

  private static toEndpoint(id: string): string {
    return `browser-${id}`;
  }

  create(id: string): string {
    const endpoint = BrowserTools.toEndpoint(id);
    this.mock.create(endpoint);
    return endpoint;
  }

  has(endpoint: string): boolean {
    return this.mock.has(endpoint);
  }

  remove(id: string): void {
    this.removeEndpoint(BrowserTools.toEndpoint(id));
  }

  private removeEndpoint(endpoint: string): void {
    this.shared.revoke(endpoint);
    stopPicking(endpoint);
    if (!this.mock.has(endpoint)) return;

    this.mock.remove(endpoint);
    this.onRemove?.(endpoint);
  }

  attachMock(url: string, guestId: number): void {
    this.mock.attach(url, guestId);
  }

  attachSharedTab(requestId: string, guestId: number): void {
    this.shared.attach(requestId, guestId);
  }

  shareTab(id: string, guestId: number): string {
    return this.shared.share(BrowserTools.toEndpoint(id), guestId);
  }

  revokeTab(id: string): void {
    this.shared.revoke(BrowserTools.toEndpoint(id));
  }

  revokeGuest(guestId: number): void {
    this.shared.revokeGuest(guestId);
  }

  stopPicking(id: string, guestId?: number): void {
    stopPicking(BrowserTools.toEndpoint(id), guestId);
  }

  async pick(id: string, guestId: number, onSelection: (selection: IBrowserElement) => void): Promise<void> {
    const endpoint = BrowserTools.toEndpoint(id);
    const sharedGuest = this.shared.guest(endpoint, guestId);
    const guest = sharedGuest ?? this.mock.guest(endpoint, guestId);
    if (!guest) throw new Error("Share this tab with the active ACP session before selecting an element.");

    const current = () => sharedGuest ? this.shared.guest(endpoint, guestId) : this.mock.guest(endpoint, guestId);
    await pickElement(endpoint, guest, () => current() === guest, selection => {
      const url = sharedGuest ? guest.getURL() : this.mock.url(endpoint) ?? guest.getURL();
      onSelection({ ...selection, url, tab: guestId });
    });
  }

  // The shared tabs and the tab showing the mock preview.
  private tabs(endpoint: string): BrowserTab[] {
    const tabs: BrowserTab[] = [];
    for (const guest of this.shared.guests(endpoint)) {
      const origin = webOrigin(guest.getURL());
      if (origin) tabs.push({ id: guest.id, kind: "shared", guest, scope: `${origin}/` });
    }

    const mock = this.mock.guest(endpoint);
    const url = this.mock.url(endpoint);
    if (mock && url) tabs.push({ id: mock.id, kind: "mock", guest: mock, scope: url });
    return tabs;
  }

  private static tabId(value: unknown): number | undefined {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new Error("Tab must be an integer id from use_tab list.");
    }
    return value;
  }

  // Returns the tab with the id, or the only tab when id is omitted.
  private resolveTab(endpoint: string, id: number | undefined): BrowserTab {
    const tabs = this.tabs(endpoint);
    if (tabs.length === 0) throw new Error("No tab is available. Ask the user to share a web tab, or call show_mock first.");
    if (id === undefined) {
      if (tabs.length > 1) throw new Error(`Several tabs are available (${tabs.map(tab => tab.id).join(", ")}). Pass tab with one of these ids.`);
      return tabs[0];
    }

    const tab = tabs.find(tab => tab.id === id);
    if (!tab) throw new Error(`Tab ${id} is not available to this session. Use use_tab list to see the available tabs.`);
    return tab;
  }

  private isAvailable(endpoint: string, tab: BrowserTab): boolean {
    return this.tabs(endpoint).some(current => current.guest === tab.guest && current.kind === tab.kind);
  }

  private async useTab(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = BrowserTools.tabId(params.tab);
    if (params.action === "list") return this.tabs(endpoint).map(summarizeTab);

    if (params.action === "navigate") {
      if (id !== undefined && this.mock.guest(endpoint, id)) {
        throw new Error(`Tab ${id} shows the mock preview. Update it with show_mock, or navigate a shared tab.`);
      }
      return this.shared.navigate(endpoint, params.url, id, params.new_tab);
    }

    const tab = this.resolveTab(endpoint, id);
    const result = await runTabAction(tab, params);
    if (params.action !== "inspect") return result;

    // Page data is returned only while the tab is still available to this session.
    if (!this.isAvailable(endpoint, tab)) throw new Error(`Tab ${tab.id} is no longer available to this session.`);
    return { tab: tab.id, kind: tab.kind, ...(result as object) };
  }

  private async screenshot(endpoint: string, params: Record<string, unknown> = {}): Promise<Screenshot> {
    const { selector } = params;
    if (selector !== undefined && typeof selector !== "string") throw new Error("Selector must be a string.");

    const tab = this.resolveTab(endpoint, BrowserTools.tabId(params.tab));
    return captureGuest(tab.guest, selector, () => this.isAvailable(endpoint, tab));
  }

  private readLogs(endpoint: string, params: Record<string, unknown> = {}) {
    const tab = this.resolveTab(endpoint, BrowserTools.tabId(params.tab));
    return { tab: tab.id, kind: tab.kind, ...TabLogs.read(tab.id, params) };
  }

  registerTools(server: Server, endpoint: string): void {
    server.setRequestHandler("tools/list", () => ({ tools: [showMockTool, useTabTool, screenshotTool, readLogsTool] }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      try {
        switch (params.name) {
          case showMockTool.name: return textResult(await this.mock.show(endpoint, params.arguments?.html));
          case useTabTool.name: return textResult(await this.useTab(endpoint, params.arguments));
          case readLogsTool.name: return textResult(this.readLogs(endpoint, params.arguments));
          case screenshotTool.name: return imageResult(await this.screenshot(endpoint, params.arguments));
          default: return textResult(`Unknown tool: ${params.name}`, true);
        }
      } catch (error) {
        return textResult(error instanceof Error ? error : String(error), true);
      }
    });
  }

  dispose(): void {
    for (const endpoint of this.mock.endpoints()) this.removeEndpoint(endpoint);
  }
}
