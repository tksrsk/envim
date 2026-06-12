import { randomUUID } from "crypto";
import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "http";
import { AddressInfo } from "net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ResultSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import * as SDK from "@agentclientprotocol/sdk";

import { IMcpApp } from "common/interface";

import { Emit } from "main/emit";
import { Setting } from "main/setting";

interface IUpstream {
  id: string;
  name: string;
  client: Client;
  servers: Set<Server>;
}

interface IMcpAppUi {
  uri: string;
  mimeType: string;
  html: string;
}

// MIME type registered by MCP Apps (SEP-1865) for UI bundles.
const MCP_APP_MIME = "text/html";
const UI_URI_PREFIX = "ui://";
const MCP_APP_HOST = "127.0.0.1";

/**
 * In-process MCP proxy.
 *
 * Today the ACP agent connects to MCP servers directly, so envim never sees the
 * MCP traffic. To support MCP Apps (interactive UI resources) envim must sit in
 * the path: it connects to each enabled upstream MCP server as a client, and
 * re-exposes them to the agent over a localhost HTTP MCP endpoint (one path per
 * upstream). All tool calls/resource reads then flow through envim, which lets
 * us detect `ui://` templates and render their HTML in the renderer.
 */
export class Mcp {
  private static httpServer: HttpServer | null = null;
  private static port = 0;
  private static upstreams: { [id: string]: IUpstream } = {};
  private static transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  /**
   * Ensure upstreams are connected and the proxy HTTP server is listening, then
   * return the `mcpServers` list to hand to the ACP agent. Servers we cannot
   * proxy (failed connection, or `type: "acp"`) fall back to being passed
   * through unchanged so behaviour is never worse than today.
   */
  static async getMcpServers(): Promise<SDK.McpServer[]> {
    const configs = (Setting.get().acp?.mcpServers || []).filter(mcp => mcp.enabled);

    if (configs.length === 0) {
      return [];
    }

    await Mcp.ensureHttpServer();

    const result: SDK.McpServer[] = [];

    for (const { server } of configs) {
      // ACP-transport servers are provided over the ACP channel, not proxied here.
      if ("type" in server && server.type === "acp") {
        result.push(server);
        continue;
      }

      const id = await Mcp.connectUpstream(server);

      if (id && Mcp.port) {
        result.push({ type: "http", name: server.name, url: `http://${MCP_APP_HOST}:${Mcp.port}/mcp/${id}`, headers: [] });
      } else {
        // Could not proxy; pass the original definition straight to the agent.
        result.push(server);
      }
    }

    return result;
  }

  static stop() {
    Object.values(Mcp.upstreams).forEach(upstream => upstream.client.close().catch(() => {}));
    Object.values(Mcp.transports).forEach(transport => transport.close().catch(() => {}));
    Mcp.httpServer?.close();

    Mcp.upstreams = {};
    Mcp.transports = {};
    Mcp.httpServer = null;
    Mcp.port = 0;
  }

  private static ensureHttpServer(): Promise<void> {
    if (Mcp.httpServer) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => Mcp.handleHttp(req, res).catch(() => Mcp.writeError(res, 500, "Internal error")));

      server.on("error", reject);
      server.listen(0, MCP_APP_HOST, () => {
        Mcp.httpServer = server;
        Mcp.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private static idFor(server: SDK.McpServer): string {
    // Stable id per upstream so repeated newSession calls reuse one connection.
    return Buffer.from(server.name).toString("hex");
  }

  private static async connectUpstream(server: SDK.McpServer): Promise<string | null> {
    const id = Mcp.idFor(server);

    if (Mcp.upstreams[id]) {
      return id;
    }

    const transport = Mcp.createClientTransport(server);

    if (!transport) {
      return null;
    }

    const client = new Client(
      { name: "envim", version: "1.0.0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as any }
    );

    try {
      await client.connect(transport);
    } catch {
      return null;
    }

    Mcp.upstreams[id] = { id, name: server.name, client, servers: new Set() };

    return id;
  }

  private static createClientTransport(server: SDK.McpServer) {
    if ("command" in server) {
      const env = (server.env || []).reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {} as Record<string, string>);
      return new StdioClientTransport({ command: server.command, args: server.args || [], env });
    }

    if (server.type === "http") {
      const headers = (server.headers || []).reduce((acc, h) => ({ ...acc, [h.name]: h.value }), {} as Record<string, string>);
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
    }

    if (server.type === "sse") {
      const headers = (server.headers || []).reduce((acc, h) => ({ ...acc, [h.name]: h.value }), {} as Record<string, string>);
      return new SSEClientTransport(new URL(server.url), { requestInit: { headers } });
    }

    return null;
  }

  private static async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = (req.url || "").match(/^\/mcp\/([^/?]+)/);
    const upstream = match && Mcp.upstreams[match[1]];

    if (!upstream) {
      return Mcp.writeError(res, 404, "Unknown MCP endpoint");
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await Mcp.readBody(req) : undefined;

    let transport = sessionId ? Mcp.transports[sessionId] : undefined;

    if (!transport && req.method === "POST" && isInitializeRequest(body)) {
      transport = Mcp.createProxyServer(upstream);
    }

    if (!transport) {
      return Mcp.writeError(res, 400, "No valid session");
    }

    await transport.handleRequest(req, res, body);
  }

  private static createProxyServer(upstream: IUpstream): StreamableHTTPServerTransport {
    const capabilities = upstream.client.getServerCapabilities() || {};
    const server = new Server({ name: `envim-proxy:${upstream.name}`, version: "1.0.0" }, { capabilities });

    // Forward tool list from upstream (SDK's built-in handler returns empty when no tools are registered via server.tool()).
    server.setRequestHandler(ListToolsRequestSchema, async request => upstream.client.listTools(request.params));

    // Intercept tool calls so we can surface MCP App UI; forward everything else.
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const result = await upstream.client.callTool(request.params);

      // @todo 動作確認後に削除

      Mcp.detectAppUi(upstream, request.params.name, result).catch(() => {});

      return result;
    });

    server.fallbackRequestHandler = async request => upstream.client.request({ method: request.method, params: request.params }, ResultSchema);
    server.fallbackNotificationHandler = async notification => upstream.client.notification(notification);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => { Mcp.transports[sessionId] = transport; },
      onsessionclosed: sessionId => { delete Mcp.transports[sessionId]; upstream.servers.delete(server); },
    });

    upstream.servers.add(server);
    server.connect(transport);

    return transport;
  }

  /**
   * Detect an MCP App UI attached to a tool result and, if present, read the
   * `ui://` HTML resource and notify the renderer. Two shapes are supported:
   *  - embedded (legacy MCP-UI): an EmbeddedResource content block carrying HTML
   *  - template (Apps SDK / SEP-1865): `_meta` references a separate `ui://` resource
   */
  private static async detectAppUi(upstream: IUpstream, toolName: string, result: any): Promise<void> {
    const ui = await Mcp.resolveAppUi(upstream, result);

    if (ui) {
      const app: IMcpApp = { server: upstream.name, tool: toolName, structuredContent: result?.structuredContent, ...ui };

      Emit.send("acp:mcp-app", app);
    }
  }

  private static async resolveAppUi(upstream: IUpstream, result: any): Promise<IMcpAppUi | null> {
    const meta = result?._meta || {};
    const templateUri: string | undefined = meta["openai/outputTemplate"] || meta["ui"]?.resourceUri || meta["mcpui.dev/ui-resource-uri"];

    if (typeof templateUri === "string" && templateUri.startsWith(UI_URI_PREFIX)) {
      return Mcp.readUiResource(upstream, templateUri);
    }

    for (const block of (result?.content || [])) {
      const resource = block?.type === "resource" ? block.resource : null;

      if (resource && typeof resource.uri === "string" && (resource.uri.startsWith(UI_URI_PREFIX) || (resource.mimeType || "").startsWith(MCP_APP_MIME)) && typeof resource.text === "string") {
        return { uri: resource.uri, mimeType: resource.mimeType || MCP_APP_MIME, html: resource.text };
      }
    }

    return null;
  }

  private static async readUiResource(upstream: IUpstream, uri: string): Promise<IMcpAppUi | null> {
    const response = await upstream.client.readResource({ uri });
    const content = (response.contents || []).find(c => typeof (c as any).text === "string");

    return content ? { uri, mimeType: (content as any).mimeType || MCP_APP_MIME, html: (content as any).text } : null;
  }

  private static readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];

      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");

        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
      req.on("error", () => resolve(undefined));
    });
  }

  private static writeError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  }
}
