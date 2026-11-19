import * as Electron from "electron";
import { randomUUID } from "crypto";
import { once } from "events";

import { MOCK_PREVIEW_ORIGIN_PREFIX } from "common/constant";

import type { Workspace } from "main/envim/workspace";

const MAX_HTML_BYTES = 1024 * 1024;
const LOAD_TIMEOUT = 5000;

interface Preview {
  url: string;
  html: string | undefined;
  pending: Promise<unknown>;
  guest?: Electron.WebContents;
  onAttach?: () => void;
}

export const showMockTool = {
  name: "show_mock",
  description: "Create or update the interactive mockup shown beside this ACP chat. Use this to prototype UI without a repository, development server, or installed dependencies. Send a complete self-contained HTML document with inline CSS and JS and sample data. Use location.hash to store UI state and restore it on load. The result includes the preview URL for identifying the same tab with Chrome DevTools MCP.",
  inputSchema: {
    type: "object" as const,
    properties: { html: { type: "string", description: "Complete interactive HTML document, maximum 1 MiB." } },
    required: ["html"],
  },
};

function baseUrl(url: string): string {
  return url.split(/[?#]/)[0];
}

export class MockPreview {
  private static readonly documents = new Map<string, Preview>();
  private readonly previews = new Map<string, Preview>();

  constructor(private readonly workspace: Workspace) {}

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

  create(endpoint: string): void {
    if (this.previews.has(endpoint)) return;

    const hostname = randomUUID();
    const preview = { url: `${MOCK_PREVIEW_ORIGIN_PREFIX}${hostname}/`, html: undefined, pending: Promise.resolve() };
    this.previews.set(endpoint, preview);
    MockPreview.documents.set(hostname, preview);
  }

  has(endpoint: string): boolean {
    return this.previews.has(endpoint);
  }

  remove(endpoint: string): void {
    const preview = this.previews.get(endpoint);
    if (!preview) return;

    MockPreview.documents.delete(new URL(preview.url).hostname);
    this.previews.delete(endpoint);
  }

  url(endpoint: string): string | undefined {
    return this.previews.get(endpoint)?.url;
  }

  attach(url: string, id: number): void {
    const preview = [...this.previews.values()].find(document => document.url === url);
    const guest = Electron.webContents.fromId(id);
    if (preview && guest?.getType() === "webview" && baseUrl(guest.getURL()) === url) {
      preview.guest = guest;
      preview.onAttach?.();
    }
  }

  // Returns the tab that currently displays this preview.
  guest(endpoint: string, guestId?: number): Electron.WebContents | undefined {
    const preview = this.previews.get(endpoint);
    const guest = preview?.guest;
    if (guest && !guest.isDestroyed() && (guestId === undefined || guest.id === guestId) && baseUrl(guest.getURL()) === preview.url) {
      return guest;
    }
    return undefined;
  }

  private async waitForGuest(preview: Preview): Promise<void> {
    const signal = AbortSignal.timeout(LOAD_TIMEOUT);
    try {
      if (!preview.guest || preview.guest.isDestroyed()) {
        await new Promise<void>((resolve, reject) => {
          preview.onAttach = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }

      const guest = preview.guest!;
      if (guest.isLoadingMainFrame()) await once(guest, "did-stop-loading", { signal });
    } catch {
      throw new Error("The mock preview did not finish loading in the browser tab.");
    } finally {
      preview.onAttach = undefined;
    }
  }

  async show(endpoint: string, html: unknown): Promise<string> {
    const preview = this.previews.get(endpoint);
    if (!preview || typeof html !== "string" || !html.trim() || Buffer.byteLength(html) > MAX_HTML_BYTES) {
      throw new Error("Expected show_mock with a nonempty HTML document of at most 1 MiB in an active preview session.");
    }

    const operation = preview.pending.then(async () => {
      if (!this.previews.has(endpoint)) throw new Error("The mock preview session has closed.");

      const existing = preview.guest;
      const currentUrl = existing && !existing.isDestroyed() ? existing.getURL() : undefined;
      preview.html = html;

      if (existing && currentUrl !== undefined) {
        const nextUrl = new URL(preview.url);
        if (baseUrl(currentUrl) === preview.url) nextUrl.hash = new URL(currentUrl).hash;
        nextUrl.searchParams.set("revision", randomUUID());
        await existing.loadURL(nextUrl.href);
      } else {
        await this.workspace.showBrowserTab(preview.url);
        await this.waitForGuest(preview);
      }
    });
    preview.pending = operation.catch(() => {});
    await operation;

    return `Mock preview: ${preview.url} (the current tab may include a revision and a state fragment)`;
  }

  endpoints(): string[] {
    return [...this.previews.keys()];
  }
}
