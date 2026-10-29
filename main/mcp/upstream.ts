import { createHash } from "crypto";

import * as AcpSDK from "@agentclientprotocol/sdk/unstable";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { WorkspaceEmit } from "main/emit";
import { McpAppService } from "main/mcp/app";

type HttpMcpServer = Extract<AcpSDK.McpServer, { type: "http" }>;

const MCP_APP_MIME = "text/html;profile=mcp-app";
const PING_TIMEOUT = 5000;

export class McpUpstream {
  private constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly client: Client,
    private readonly emit: WorkspaceEmit,
    app: McpAppService,
  ) {
    client.setNotificationHandler("notifications/tools/list_changed", () => app.onToolsChanged(id));
    client.setNotificationHandler("notifications/resources/list_changed", () => app.onResourcesChanged(id));

    emit.on(`mcp:resource:read:${id}`, params => client.readResource(params));
    emit.on(`mcp:resource:templates:list:${id}`, params => client.listResourceTemplates(params));
    emit.on(`mcp:resources:list:${id}`, params => client.listResources(params));
    emit.on(`mcp:tool:call:${id}`, params => client.callTool(params));
  }

  static async connect(id: string, server: HttpMcpServer, app: McpAppService, emit: WorkspaceEmit): Promise<McpUpstream | null> {
    const client = new Client(
      { name: "envim", version: "1.0.0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } } as any }
    );

    try {
      await client.connect(McpUpstream.createTransport(server));

      return new McpUpstream(id, server.name, client, emit, app);
    } catch {
      await client.close().catch(() => {});

      return null;
    }
  }

  async close(): Promise<void> {
    this.emit.off(`mcp:resource:read:${this.id}`);
    this.emit.off(`mcp:resource:templates:list:${this.id}`);
    this.emit.off(`mcp:resources:list:${this.id}`);
    this.emit.off(`mcp:tool:call:${this.id}`);

    await this.client.close().catch(() => {});
  }

  private static createTransport(server: HttpMcpServer): StreamableHTTPClientTransport {
    const requestInit = { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) };

    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
  }
}

export class McpUpstreamRegistry {
  private upstreams = new Map<string, McpUpstream>();
  private syncPromise: Promise<void> = Promise.resolve();

  constructor(private readonly app: McpAppService, private readonly emit: WorkspaceEmit) {}

  sync(servers: AcpSDK.McpServer[]): Promise<Map<AcpSDK.McpServer, McpUpstream>> {
    const operation = this.syncPromise.then(() => this.syncNow(servers));

    this.syncPromise = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private async syncNow(servers: AcpSDK.McpServer[]): Promise<Map<AcpSDK.McpServer, McpUpstream>> {
    const next = new Map<string, McpUpstream>();
    const resolved = new Map<AcpSDK.McpServer, McpUpstream>();

    for (const server of servers) {
      if (!McpUpstreamRegistry.isHttpServer(server)) {
        continue;
      }

      const headers = [...server.headers].sort((left, right) => left.name.localeCompare(right.name));
      const definition = JSON.stringify({ name: server.name, type: server.type, url: server.url, headers });
      const id = createHash("sha256").update(definition).digest("hex");
      const upstream = next.get(id) || await this.reuse(id) || await McpUpstream.connect(id, server, this.app, this.emit);

      if (upstream) {
        next.set(id, upstream);
        resolved.set(server, upstream);
      }
    }

    const removed = [...this.upstreams.entries()]
      .filter(([id]) => !next.has(id))
      .map(([, upstream]) => upstream);

    this.upstreams = next;
    await Promise.all(removed.map(upstream => upstream.close()));

    return resolved;
  }

  private async reuse(id: string): Promise<McpUpstream | null> {
    const upstream = this.upstreams.get(id);

    if (!upstream) return null;

    try {
      await upstream.client.ping({ timeout: PING_TIMEOUT });

      return upstream;
    } catch {
      this.upstreams.delete(id);
      await upstream.close();
      this.app.onToolsChanged(id);

      return null;
    }
  }

  get(upstreamId: string): McpUpstream {
    const upstream = this.upstreams.get(upstreamId);

    if (!upstream) {
      throw new Error("Unknown MCP upstream: " + upstreamId);
    }

    return upstream;
  }

  private static isHttpServer(server: AcpSDK.McpServer): server is HttpMcpServer {
    return "type" in server && server.type === "http";
  }
}
