import type * as Electron from "electron";
import type { Server } from "@modelcontextprotocol/server";

import type { IBrowserElement } from "common/interface";

import { captureGuest, screenshotTool, type Screenshot } from "main/mcp/capture";
import { MockPreview, showMockTool } from "main/mcp/preview";
import { SharedBrowser, sharedTabTool } from "main/mcp/sharedbrowser";
import { pickElement, stopPicking } from "main/mcp/picker";
import type { Workspace } from "main/envim/workspace";

// Kept as-is so existing agent permission rules for mcp__envim-mock-preview__* keep working.
export const BROWSER_TOOLS_SERVER_NAME = "envim-mock-preview";

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

// Browser tools exposed to one ACP session: the mock preview, the shared HTTP(S) tab and element picking.
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
      onSelection(sharedGuest
        ? { ...selection, url: guest.getURL(), tab: guestId }
        : { ...selection, url: this.mock.url(endpoint) ?? guest.getURL() });
    });
  }

  // Tabs the screenshot tool can capture: the shared tabs and the tab showing the mock preview.
  private captureTargets(endpoint: string): Electron.WebContents[] {
    const mock = this.mock.guest(endpoint);
    return [...this.shared.guests(endpoint), ...(mock ? [mock] : [])];
  }

  private async screenshot(endpoint: string, params: Record<string, unknown> = {}): Promise<Screenshot> {
    const { tab, selector } = params;
    if (tab !== undefined && (typeof tab !== "number" || !Number.isInteger(tab))) throw new Error("Tab must be an integer id.");
    if (selector !== undefined && typeof selector !== "string") throw new Error("Selector must be a string.");

    const targets = this.captureTargets(endpoint);
    if (targets.length === 0) throw new Error("No tab is available. Share a web tab or call show_mock first.");
    if (tab === undefined && targets.length > 1) {
      throw new Error(`Several tabs are available (${targets.map(guest => guest.id).join(", ")}). Pass tab with one of these ids.`);
    }

    const guest = tab === undefined ? targets[0] : targets.find(guest => guest.id === tab);
    if (!guest) throw new Error(`Tab ${tab} is not shared with this session and is not the mock preview.`);
    return captureGuest(guest, selector, () => this.captureTargets(endpoint).includes(guest));
  }

  registerTools(server: Server, endpoint: string): void {
    server.setRequestHandler("tools/list", () => ({ tools: [showMockTool, sharedTabTool, screenshotTool] }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      try {
        switch (params.name) {
          case showMockTool.name: return textResult(await this.mock.show(endpoint, params.arguments?.html));
          case sharedTabTool.name: return textResult(await this.shared.act(endpoint, params.arguments));
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
