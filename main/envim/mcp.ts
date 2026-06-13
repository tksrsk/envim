import { randomUUID } from "crypto";
import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "http";
import { AddressInfo } from "net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ResourceListChangedNotificationSchema, ResultSchema,
  ToolListChangedNotificationSchema, isInitializeRequest, CallToolRequest, CallToolResult,
  ListResourceTemplatesRequest, ListResourcesRequest, ReadResourceRequest,
  TextResourceContents, Tool
} from "@modelcontextprotocol/sdk/types.js";

import * as SDK from "@agentclientprotocol/sdk";

import { Emit } from "main/emit";
import { McpTunnel } from "main/envim/mcp-tunnel";
import { Setting } from "main/setting";

interface IUpstream {
  path: string;
  name: string;
  client: Client;
  servers: Set<Server>;
  toolUiUris: { [toolName: string]: string };
}

const MCP_APP_MIME = "text/html;profile=mcp-app";
const UI_URI_PREFIX = "ui://";
const PROXY_HOST = "127.0.0.1";

export class Mcp {
  private static initialized = false;
  private static httpServer: HttpServer | null = null;
  private static upstreams: { [path: string]: IUpstream } = {};
  private static transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  static async getMcpServers(): Promise<SDK.McpServer[]> {
    Mcp.setup();

    const servers = (Setting.get().acp?.mcpServers || []).filter(mcp => mcp.enabled).map(mcp => mcp.server);

    if (servers.length === 0) {
      return [];
    }

    const proxyPort = await Mcp.ensureHttpServer();

    try {
      await McpTunnel.start(proxyPort);
    } catch (error) {
      Mcp.log("Failed to start Neovim MCP tunnel; using original MCP definitions", error);
    }

    if (!McpTunnel.getUrl()) {
      return servers;
    }

    return Promise.all(servers.map(server => Mcp.proxyServer(server)));
  }

  private static setup(): void {
    if (Mcp.initialized) return;

    Mcp.initialized = true;
    Emit.on("mcp-apps:call-tool", (server: string, params: CallToolRequest["params"]) => Mcp.clientFor(server).callTool(params));
    Emit.on("mcp-apps:list-resources", (server: string, params: ListResourcesRequest["params"]) => Mcp.clientFor(server).listResources(params));
    Emit.on("mcp-apps:list-resource-templates", (server: string, params: ListResourceTemplatesRequest["params"]) => Mcp.clientFor(server).listResourceTemplates(params));
    Emit.on("mcp-apps:read-resource", (server: string, params: ReadResourceRequest["params"]) => Mcp.clientFor(server).readResource(params));
  }

  private static clientFor(server: string): Client {
    const upstream = Object.values(Mcp.upstreams).find(item => item.name === server);

    if (!upstream) throw new Error("Unknown MCP server: " + server);

    return upstream.client;
  }

  static stop() {
    Object.values(Mcp.upstreams).forEach(upstream => upstream.client.close().catch(() => {}));
    Object.values(Mcp.transports).forEach(transport => transport.close().catch(() => {}));
    Mcp.httpServer?.close();
    McpTunnel.stop();

    Mcp.upstreams = {};
    Mcp.transports = {};
    Mcp.httpServer = null;
  }

  private static async proxyServer(server: SDK.McpServer): Promise<SDK.McpServer> {
    if ("type" in server && server.type === "acp") {
      return server;
    }

    const upstream = await Mcp.connectUpstream(server);

    return upstream && McpTunnel.getUrl()
      ? { type: "http", name: server.name, url: `${McpTunnel.getUrl()}/mcp/${upstream.path}`, headers: [] }
      : server;
  }

  private static ensureHttpServer(): Promise<number> {
    if (Mcp.httpServer) {
      return Promise.resolve((Mcp.httpServer.address() as AddressInfo).port);
    }

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => Mcp.handleHttp(req, res).catch(() => Mcp.writeError(res, 500, "Internal error")));

      server.on("error", reject);
      server.listen(0, PROXY_HOST, () => {
        Mcp.httpServer = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private static async connectUpstream(server: SDK.McpServer): Promise<IUpstream | null> {
    const path = Buffer.from(server.name).toString("hex");

    if (Mcp.upstreams[path]) {
      return Mcp.upstreams[path];
    }

    const transport = Mcp.createClientTransport(server);

    if (!transport) {
      return null;
    }

    const client = new Client(
      { name: "envim", version: "1.0.0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } } as any }
    );

    try {
      await client.connect(transport);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => Emit.send("mcp-apps:tools-changed", server.name));
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => Emit.send("mcp-apps:resources-changed", server.name));
    } catch (error) {
      Mcp.log(`Failed to connect to MCP server ${server.name}`, error);

      return null;
    }

    const upstream = { path, name: server.name, client, servers: new Set<Server>(), toolUiUris: {} };

    Mcp.upstreams[path] = upstream;

    return upstream;
  }

  private static createClientTransport(server: SDK.McpServer) {
    if ("command" in server) {
      const env = Mcp.keyValuePairs(server.env);

      return new StdioClientTransport({ command: server.command, args: server.args || [], env });
    }

    if (server.type === "http") {
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Mcp.keyValuePairs(server.headers) } });
    }

    if (server.type === "sse") {
      return new SSEClientTransport(new URL(server.url), { requestInit: { headers: Mcp.keyValuePairs(server.headers) } });
    }

    return null;
  }

  private static keyValuePairs(values: { name: string; value: string; }[] | null | undefined): Record<string, string> {
    return Object.fromEntries((values || []).map(value => [value.name, value.value]));
  }

  private static async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url || "").match(/^\/mcp\/([^/?]+)/)?.[1];
    const upstream = path ? Mcp.upstreams[path] : undefined;

    if (!upstream) {
      return Mcp.writeError(res, 404, "Unknown MCP endpoint");
    }

    const body = req.method === "POST" ? await Mcp.readBody(req) : undefined;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
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

    Mcp.registerProxyHandlers(server, upstream);

    const transport = Mcp.createServerTransport(server, upstream);

    upstream.servers.add(server);
    server.connect(transport);

    return transport;
  }

  private static registerProxyHandlers(server: Server, upstream: IUpstream): void {
    server.setRequestHandler(ListToolsRequestSchema, async request => {
      const result = await upstream.client.listTools(request.params);

      Mcp.rememberToolUiUris(upstream, result.tools);

      return result;
    });

    server.setRequestHandler(CallToolRequestSchema, async request => {
      const result = await upstream.client.callTool(request.params);

      Mcp.renderApp(upstream, request.params, result).catch(error =>
        Mcp.log(`Failed to resolve UI for ${upstream.name}/${request.params.name}`, error)
      );

      return result;
    });

    server.fallbackRequestHandler = async request => upstream.client.request({ method: request.method, params: request.params }, ResultSchema);
    server.fallbackNotificationHandler = async notification => upstream.client.notification(notification);
  }

  private static createServerTransport(server: Server, upstream: IUpstream): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => { Mcp.transports[sessionId] = transport; },
      onsessionclosed: sessionId => { delete Mcp.transports[sessionId]; upstream.servers.delete(server); },
    });

    return transport;
  }

  private static async renderApp(upstream: IUpstream, request: CallToolRequest["params"], result: CallToolResult): Promise<void> {
    if (!upstream.toolUiUris[request.name]) {
      Mcp.rememberToolUiUris(upstream, (await upstream.client.listTools()).tools);
    }

    const uri = upstream.toolUiUris[request.name];
    const resource = uri ? await Mcp.readAppResource(upstream, uri) : null;

    if (resource) {
      Emit.send("mcp-apps:render", { server: upstream.name, tool: request.name, request, resource, result });
    }
  }

  private static rememberToolUiUris(upstream: IUpstream, tools: Tool[]): void {
    for (const tool of tools) {
      const uri = tool._meta?.ui?.resourceUri;

      if (typeof tool.name === "string" && typeof uri === "string" && uri.startsWith(UI_URI_PREFIX)) {
        upstream.toolUiUris[tool.name] = uri;
      }
    }
  }

  private static async readAppResource(upstream: IUpstream, uri: string): Promise<TextResourceContents | null> {
    const response = await upstream.client.readResource({ uri });
    const content = (response.contents || []).find(c =>
      c.uri === uri && c.mimeType === MCP_APP_MIME && ("text" in c || "blob" in c)
    );

    if (!content) {
      return null;
    }

    const text = "text" in content ? content.text : Buffer.from(content.blob, "base64").toString("utf8");

    return { uri, mimeType: MCP_APP_MIME, text };
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

  private static log(message: string, error?: unknown): void {
    Emit.send("console:log", `[mcp-proxy]: ${message}`, error instanceof Error ? error.message : String(error || ""));
  }
}
