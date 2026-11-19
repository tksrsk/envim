import type { Server } from "@modelcontextprotocol/server";

import type { IBrowserElement } from "common/interface";

import { MockPreview, showMockTool } from "main/mcp/preview";
import { SharedBrowser, sharedTabTool } from "main/mcp/sharedbrowser";
import { pickElement, stopPicking } from "main/mcp/picker";
import type { Workspace } from "main/envim/workspace";

// Kept as-is so existing agent permission rules for mcp__envim-mock-preview__* keep working.
export const BROWSER_TOOLS_SERVER_NAME = "envim-mock-preview";

type ToolResult = { isError?: true; content: { type: "text"; text: string }[] };

function textResult(value: unknown, isError = false): ToolResult {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: "text", text }] };
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

  registerTools(server: Server, endpoint: string): void {
    server.setRequestHandler("tools/list", () => ({ tools: [showMockTool, sharedTabTool] }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      try {
        switch (params.name) {
          case showMockTool.name: return textResult(await this.mock.show(endpoint, params.arguments?.html));
          case sharedTabTool.name: return textResult(await this.shared.act(endpoint, params.arguments));
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
