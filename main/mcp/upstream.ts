import { createHash } from "crypto";

import * as AcpSDK from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as McpTypes from "@modelcontextprotocol/sdk/types.js";

export interface IMcpUpstream {
  id: string;
  name: string;
  client: Client;
}

interface IMcpUpstreamRegistryOptions {
  onToolsChanged: (upstreamId: string) => void;
  onResourcesChanged: (upstreamId: string) => void;
}

type HttpMcpServer = Extract<AcpSDK.McpServer, { type: "http" | "sse" }>;

const MCP_APP_MIME = "text/html;profile=mcp-app";

export class McpUpstreamRegistry {
  private upstreams = new Map<string, IMcpUpstream>();

  constructor(private options: IMcpUpstreamRegistryOptions) {}

  async sync(servers: AcpSDK.McpServer[]): Promise<Map<string, IMcpUpstream>> {
    const next = new Map<string, IMcpUpstream>();

    for (const server of servers) {
      if (!McpUpstreamRegistry.isHttpServer(server)) {
        continue;
      }

      const id = McpUpstreamRegistry.idFor(server);
      const existing = next.get(id) || this.upstreams.get(id);

      if (existing) {
        next.set(id, existing);
        continue;
      }

      const upstream = await this.connect(id, server);

      if (upstream) {
        next.set(id, upstream);
      }
    }

    const removed = [...this.upstreams.entries()]
      .filter(([id]) => !next.has(id))
      .map(([, upstream]) => upstream);

    this.upstreams = next;
    await Promise.all(removed.map(upstream => upstream.client.close().catch(() => {})));

    return new Map(this.upstreams);
  }

  get(upstreamId: string): IMcpUpstream {
    const upstream = this.upstreams.get(upstreamId);

    if (!upstream) {
      throw new Error("Unknown MCP upstream: " + upstreamId);
    }

    return upstream;
  }

  static idFor(server: AcpSDK.McpServer): string {
    if (!McpUpstreamRegistry.isHttpServer(server)) {
      throw new Error("MCP upstream registry only accepts HTTP and SSE servers");
    }

    const headers = Object.entries(McpUpstreamRegistry.keyValuePairs(server.headers))
      .sort(([left], [right]) => left.localeCompare(right));
    const definition = JSON.stringify({ name: server.name, type: server.type, url: server.url, headers });

    return createHash("sha256").update(definition).digest("hex");
  }

  private async connect(id: string, server: HttpMcpServer): Promise<IMcpUpstream | null> {
    const client = new Client(
      { name: "envim", version: "1.0.0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } } as any }
    );

    try {
      await client.connect(McpUpstreamRegistry.createTransport(server));
      client.setNotificationHandler(McpTypes.ToolListChangedNotificationSchema, () => this.options.onToolsChanged(id));
      client.setNotificationHandler(McpTypes.ResourceListChangedNotificationSchema, () => this.options.onResourcesChanged(id));

      return { id, name: server.name, client };
    } catch {
      await client.close().catch(() => {});

      return null;
    }
  }

  private static createTransport(server: HttpMcpServer): StreamableHTTPClientTransport | SSEClientTransport {
    const requestInit = { headers: McpUpstreamRegistry.keyValuePairs(server.headers) };

    return server.type === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit })
      : new SSEClientTransport(new URL(server.url), { requestInit });
  }

  private static isHttpServer(server: AcpSDK.McpServer): server is HttpMcpServer {
    return "type" in server && (server.type === "http" || server.type === "sse");
  }

  private static keyValuePairs(values: { name: string; value: string; }[]): Record<string, string> {
    return Object.fromEntries(values.map(value => [value.name, value.value]));
  }
}
