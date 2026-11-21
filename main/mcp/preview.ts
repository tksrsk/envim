import * as Electron from "electron";
import { randomUUID } from "crypto";

import type { SharedBrowser } from "main/mcp/sharedbrowser";

const MAX_HTML_BYTES = 1024 * 1024;

export const MOCK_PATH = "/mock";
// The mock runs sandboxed and offline, with scripts and inline styles only.
export const MOCK_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
};

export const showMockTool = {
  name: "show_mock",
  description: "Create or update the interactive mockup shown beside this ACP chat. Use this to prototype UI without a repository, development server, or installed dependencies. Send a complete self-contained HTML document with inline CSS and JS and sample data. Use location.hash to store UI state and restore it on load. The result includes the tab id for use_tab and screenshot, which can inspect, operate and capture the preview.",
  inputSchema: {
    type: "object" as const,
    properties: { html: { type: "string", description: "Complete interactive HTML document, maximum 1 MiB." } },
    required: ["html"],
  },
};

function baseUrl(url: string): string {
  return url.split(/[?#]/)[0];
}

// The mock preview: an HTML document that the browser server serves at MOCK_PATH, shown in a tab shared with the agent.
export class MockPreview {
  html?: string;
  private pending: Promise<unknown> = Promise.resolve();

  // origin returns the origin of the browser server.
  constructor(private readonly shared: SharedBrowser, private readonly origin: () => Promise<string>) {}

  show(html: unknown, signal: AbortSignal): Promise<string> {
    if (typeof html !== "string" || !html.trim() || Buffer.byteLength(html) > MAX_HTML_BYTES) {
      return Promise.reject(new Error("Expected show_mock with a nonempty HTML document of at most 1 MiB."));
    }

    const operation = this.pending.then(() => this.update(html, signal));
    this.pending = operation.catch(() => {});
    return operation;
  }

  // Shows the document in the tab that has it, keeping the state in the page's fragment, or in a new tab.
  private async update(html: string, signal: AbortSignal): Promise<string> {
    const url = `${await this.origin()}${MOCK_PATH}`;
    signal.throwIfAborted();

    this.html = html;
    const tab = Electron.webContents.getAllWebContents().find(contents => contents.getType() === "webview" && baseUrl(contents.getURL()) === url);
    if (!tab) return this.shared.navigate(url, undefined, true, signal);

    const next = new URL(tab.getURL());
    next.searchParams.set("revision", randomUUID());
    this.shared.share(tab.id);
    await tab.loadURL(next.href);
    return `Updated the mock preview in shared tab ${tab.id}.`;
  }
}
