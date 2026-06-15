import * as McpTypes from "@modelcontextprotocol/sdk/types.js";

import { Emit } from "main/emit";
import { IMcpUpstream, McpUpstreamRegistry } from "main/mcp/upstream";

const MCP_APP_MIME = "text/html;profile=mcp-app";
const UI_URI_PREFIX = "ui://";

export class McpAppService {
  private initialized = false;
  private toolUiUris = new Map<string, { [toolName: string]: string }>();

  constructor(private registry: McpUpstreamRegistry) {}

  setup(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    Emit.on("mcp-apps:call-tool", (upstreamId: string, params: McpTypes.CallToolRequest["params"]) =>
      this.registry.get(upstreamId).client.callTool(params)
    );
    Emit.on("mcp-apps:list-resources", (upstreamId: string, params: McpTypes.ListResourcesRequest["params"]) =>
      this.registry.get(upstreamId).client.listResources(params)
    );
    Emit.on(
      "mcp-apps:list-resource-templates",
      (upstreamId: string, params: McpTypes.ListResourceTemplatesRequest["params"]) =>
        this.registry.get(upstreamId).client.listResourceTemplates(params)
    );
    Emit.on("mcp-apps:read-resource", (upstreamId: string, params: McpTypes.ReadResourceRequest["params"]) =>
      this.registry.get(upstreamId).client.readResource(params)
    );
  }

  async onToolResult(
    upstreamId: string,
    request: McpTypes.CallToolRequest["params"],
    result: McpTypes.CallToolResult,
  ): Promise<void> {
    const upstream = this.registry.get(upstreamId);
    let toolUiUris = this.toolUiUris.get(upstreamId);

    if (!toolUiUris) {
      toolUiUris = McpAppService.toolUiUrisFor((await upstream.client.listTools()).tools);
      this.toolUiUris.set(upstreamId, toolUiUris);
    }

    const uri = toolUiUris[request.name];
    const resource = uri ? await McpAppService.readAppResource(upstream, uri) : null;

    if (resource) {
      Emit.send("mcp-apps:render", { upstreamId, server: upstream.name, tool: request.name, request, resource, result });
    }
  }

  onToolsChanged(upstreamId: string): void {
    this.toolUiUris.delete(upstreamId);
    Emit.send("mcp-apps:tools-changed", upstreamId);
  }

  onResourcesChanged(upstreamId: string): void {
    Emit.send("mcp-apps:resources-changed", upstreamId);
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

  private static async readAppResource(upstream: IMcpUpstream, uri: string): Promise<McpTypes.TextResourceContents | null> {
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
