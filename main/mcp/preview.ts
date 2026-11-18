import * as Electron from "electron";
import { randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import type { Server } from "@modelcontextprotocol/server";
import { pageSelector } from "main/mcp/browser-page";
import { SharedBrowser, sharedTabTool } from "main/mcp/shared-browser";
import { pickMockElement } from "main/mcp/pick-element";
import type { IMockPreviewElement } from "common/interface";
import type { Workspace } from "main/envim/workspace";

export const MOCK_PREVIEW_SCHEME = "envim-mock";
const MAX_HTML_BYTES = 1024 * 1024;

interface Preview {
  url: string;
  html: string | undefined;
  pending: Promise<unknown>;
  guest?: Electron.WebContents;
}

export class MockPreview {
  private static readonly picking = new Map<Electron.WebContents, { endpoint: string; guestId: number; abort: () => void }>();
  private static readonly documents = new Map<string, Preview>();
  private readonly previews = new Map<string, Preview>();

  private readonly shared: SharedBrowser;

  constructor(private readonly workspace: Workspace) {
    this.shared = new SharedBrowser(workspace.emit, endpoint => this.stopPickingEndpoint(endpoint),
      (url, requestId) => workspace.showBrowserTab(url, requestId));
  }

  shareTab(previewId: string, guestId: number): string {
    return this.shared.share(`mock-${previewId}`, guestId);
  }

  revokeTab(previewId: string, guestId?: number): void {
    this.shared.revoke(`mock-${previewId}`, guestId);
  }

  attachSharedTab(requestId: string, guestId: number): void {
    this.shared.attach(requestId, guestId);
  }

  static serve(request: Request): Response {
    const url = new URL(request.url);
    const preview = MockPreview.documents.get(url.hostname);
    if (request.method !== "GET" || url.pathname !== "/" || preview?.html === undefined) {
      return new Response(null, { status: 404 });
    }

    return new Response(preview.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
      },
    });
  }

  endpoint(id: string): string {
    const endpoint = `mock-${id}`;
    if (!this.previews.has(endpoint)) {
      const hostname = randomUUID();
      const preview = { url: `${MOCK_PREVIEW_SCHEME}://${hostname}/`, html: undefined, pending: Promise.resolve() };
      this.previews.set(endpoint, preview);
      MockPreview.documents.set(hostname, preview);
    }
    return endpoint;
  }

  has(endpoint: string): boolean {
    return this.previews.has(endpoint);
  }

  remove(id: string): void {
    this.removeEndpoint(`mock-${id}`);
  }

  private removeEndpoint(endpoint: string): void {
    this.shared.revoke(endpoint);
    this.stopPickingEndpoint(endpoint);
    const preview = this.previews.get(endpoint);
    if (!preview) return;

    MockPreview.documents.delete(new URL(preview.url).hostname);
    this.previews.delete(endpoint);
  }

  attach(url: string, id: number): void {
    const preview = [...this.previews.values()].find(document => document.url === url);
    const guest = Electron.webContents.fromId(id);
    if (preview && guest?.getType() === "webview" && guest.getURL().split(/[?#]/)[0] === url) {
      preview.guest = guest;
    }
  }

  static isPicking(guest: Electron.WebContents): boolean {
    return MockPreview.picking.has(guest);
  }

  stopPicking(previewId: string, guestId?: number): void {
    this.stopPickingEndpoint(`mock-${previewId}`, guestId);
  }

  private stopPickingEndpoint(endpoint: string, guestId?: number): void {
    for (const picker of MockPreview.picking.values()) {
      if (picker.endpoint === endpoint && (guestId === undefined || picker.guestId === guestId)) picker.abort();
    }
  }

  async pick(previewId: string, guestId: number, onSelection: (selection: IMockPreviewElement) => void): Promise<void> {
    const endpoint = `mock-${previewId}`;
    const preview = this.previews.get(endpoint);
    const sharedGuest = this.shared.guest(endpoint, guestId);
    const guest = sharedGuest ?? preview?.guest;
    if (!guest || guest.isDestroyed() || guest.id !== guestId ||
        (!sharedGuest && guest.getURL().split(/[?#]/)[0] !== preview?.url)) {
      throw new Error("Share this tab with the active ACP session before selecting an element.");
    }
    if (MockPreview.isPicking(guest)) return;

    const key = JSON.stringify(randomUUID());
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cancel = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const navigate = (event: Electron.WebContentsDidStartNavigationEventParams) => {
      if (event.isMainFrame && !event.isSameDocument) abort();
    };
    const url = guest.getURL();
    const picker = `(globalThis.envimElementPicker?.key === ${key} ? globalThis.envimElementPicker : null)`;
    let code = `(${pickMockElement.toString()})(${pageSelector.toString()}, ${key})`;
    MockPreview.picking.set(guest, { endpoint, guestId, abort });
    guest.once("destroyed", abort);
    guest.on("did-start-navigation", navigate);
    guest.focus();

    try {
      while (!controller.signal.aborted) {
        const selection = await Promise.race([
          cancel, guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]),
        ]);
        if (!selection || controller.signal.aborted || guest.isDestroyed()) break;
        if (sharedGuest && this.shared.guest(endpoint, guestId) !== guest) break;
        if (!sharedGuest && this.previews.get(endpoint) !== preview) break;

        onSelection({ ...selection, url: sharedGuest ? guest.getURL() : (preview?.url ?? url) });
        code = `${picker}?.next()`;
      }
    } finally {
      MockPreview.picking.delete(guest);
      guest.removeListener("destroyed", abort);
      guest.removeListener("did-start-navigation", navigate);
      if (!guest.isDestroyed() && !guest.isLoadingMainFrame()) {
        await guest.executeJavaScriptInIsolatedWorld(1001, [{ code: `${picker}?.stop()` }]).catch(() => {});
      }
    }
  }

  private async waitForGuest(preview: Preview): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const guest = preview.guest;
      if (guest && !guest.isDestroyed() && !guest.isLoadingMainFrame()) return;

      await delay(50);
    }
    throw new Error("The mock preview did not finish loading in the browser tab.");
  }

  registerTools(server: Server, endpoint: string): void {
    server.setRequestHandler("tools/list", () => ({
      tools: [{
        name: "show_mock",
        description: "Create or update the interactive mockup shown beside this ACP chat. Use this to prototype UI without a repository, development server, or installed dependencies. Send a complete self-contained HTML document with inline CSS and JS and sample data. Use location.hash to store UI state and restore it on load. The result includes the preview URL for identifying the same tab with Chrome DevTools MCP.",
        inputSchema: {
          type: "object",
          properties: { html: { type: "string", description: "Complete interactive HTML document, maximum 1 MiB." } },
          required: ["html"],
        },
      }, sharedTabTool],
    }));

    server.setRequestHandler("tools/call", async ({ params }) => {
      if (params.name === sharedTabTool.name) {
        try {
          const result = await this.shared.act(endpoint, params.arguments);
          return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      }

      const html = params.arguments?.html;
      const preview = this.previews.get(endpoint);
      if (params.name !== "show_mock" || !preview || typeof html !== "string" || !html.trim() || Buffer.byteLength(html) > MAX_HTML_BYTES) {
        return { isError: true, content: [{ type: "text", text: "Expected show_mock with a nonempty HTML document of at most 1 MiB in an active preview session." }] };
      }

      const operation = preview.pending.then(async () => {
        if (!this.previews.has(endpoint)) throw new Error("The mock preview session has closed.");

        const existing = preview.guest;
        const currentUrl = existing && !existing.isDestroyed() ? existing.getURL() : undefined;
        preview.html = html;

        if (existing && currentUrl !== undefined) {
          const nextUrl = new URL(preview.url);
          if (currentUrl.split(/[?#]/)[0] === preview.url) nextUrl.hash = new URL(currentUrl).hash;
          nextUrl.searchParams.set("revision", randomUUID());
          await existing.loadURL(nextUrl.href);
        } else {
          await this.workspace.showBrowserTab(preview.url);
          await this.waitForGuest(preview);
        }
      });
      preview.pending = operation.catch(() => {});
      try {
        await operation;
        return { content: [{ type: "text", text: `Mock preview: ${preview.url} (the current tab may include a revision and a state fragment)` }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }

  dispose(): void {
    for (const endpoint of this.previews.keys()) this.removeEndpoint(endpoint);
  }
}
