import * as McpTypes from "@modelcontextprotocol/sdk/types.js";

import { Workspace } from "main/envim/workspace";
import { McpUpstream } from "main/mcp/upstream";

const MCP_APP_MIME = "text/html;profile=mcp-app";
const UI_URI_PREFIX = "ui://";

export class McpAppService {
  private toolUiUris = new Map<string, { [toolName: string]: string }>();

  constructor(public readonly workspace: Workspace) {}

  async getToolResource(
    upstream: McpUpstream,
    toolName: string,
  ): Promise<McpTypes.TextResourceContents | null> {
    let toolUiUris = this.toolUiUris.get(upstream.id);

    if (!toolUiUris) {
      toolUiUris = McpAppService.toolUiUrisFor((await upstream.client.listTools()).tools);
      this.toolUiUris.set(upstream.id, toolUiUris);
    }

    const uri = toolUiUris[toolName];

    return uri ? McpAppService.readAppResource(upstream, uri) : null;
  }

  onToolsChanged(upstreamId: string): void {
    this.toolUiUris.delete(upstreamId);
    this.workspace.emit.send("mcp-apps:tools-changed", upstreamId);
  }

  onResourcesChanged(upstreamId: string): void {
    this.workspace.emit.send("mcp-apps:resources-changed", upstreamId)
  }

  onUpstreamsChanged(upstreamIds: Iterable<string>): void {
    const active = new Set(upstreamIds);

    for (const upstreamId of this.toolUiUris.keys()) {
      if (!active.has(upstreamId)) {
        this.toolUiUris.delete(upstreamId);
      }
    }
  }

  private static toolUiUrisFor(tools: McpTypes.Tool[]): { [toolName: string]: string } {
    const uris: { [toolName: string]: string } = {};

    for (const tool of tools) {
      const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
      const uri = ui?.resourceUri;

      if (typeof tool.name === "string" && typeof uri === "string" && uri.startsWith(UI_URI_PREFIX)) {
        uris[tool.name] = uri;
      }
    }

    return uris;
  }

  private static async readAppResource(upstream: McpUpstream, uri: string): Promise<McpTypes.TextResourceContents | null> {
    if (!uri.startsWith(UI_URI_PREFIX)) {
      return null;
    }

    const response = await upstream.client.readResource({ uri });
    const content = (response.contents || []).find(item =>
      item.uri === uri && item.mimeType === MCP_APP_MIME && ("text" in item || "blob" in item)
    );

    if (!content) {
      return null;
    }

    const text = "text" in content ? content.text : Buffer.from(content.blob, "base64").toString("utf8");

    return { uri, mimeType: MCP_APP_MIME, text };
  }
}
