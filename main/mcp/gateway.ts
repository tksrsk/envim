import { randomUUID } from "crypto";
import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "http";
import { AddressInfo, createConnection, Socket } from "net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as McpTypes from "@modelcontextprotocol/sdk/types.js";

import { Emit } from "main/emit";
import { IMcpUpstream, McpUpstreamRegistry } from "main/mcp/upstream";

interface IMcpGatewaySession {
  upstreamId: string;
  transport: StreamableHTTPServerTransport;
}

type OnToolResult = (
  upstreamId: string,
  request: McpTypes.CallToolRequest["params"],
  result: McpTypes.CallToolResult,
) => Promise<void> | void;

const GATEWAY_HOST = "127.0.0.1";

export class McpGateway {
  private static active: McpGateway | null = null;

  private httpServer: HttpServer | null = null;
  private pending: { [connectionId: string]: Buffer[] } = {};
  private proxyPort = 0;
  private sessions = new Map<string, IMcpGatewaySession>();
  private sockets: { [connectionId: string]: Socket } = {};
  private startPromise: Promise<string> | null = null;

  constructor(
    private registry: McpUpstreamRegistry,
    private onToolResult: OnToolResult,
  ) {
    McpGateway.active = this;
  }

  static setup(): void {
    McpGateway.active?.switchWorkspace();
    Emit.share("envim:luafile", "mcp.lua");
  }

  start(): Promise<string> {
    if (!this.startPromise) {
      const startPromise = this.startGateway().catch(error => {
        if (this.startPromise === startPromise) {
          this.startPromise = null;
        }
        throw error;
      });

      this.startPromise = startPromise;
    }

    return this.startPromise;
  }

  urlFor(upstreamId: string, gatewayUrl: string): string {
    this.registry.get(upstreamId);

    return `${gatewayUrl}/mcp/${encodeURIComponent(upstreamId)}`;
  }

  static onOpen(connectionId: string): void {
    const gateway = McpGateway.active;

    if (!gateway?.proxyPort) {
      McpGateway.closeRemote(connectionId);
      return;
    }

    const socket = createConnection({ host: GATEWAY_HOST, port: gateway.proxyPort }, () => {
      for (const data of gateway.pending[connectionId] || []) {
        socket.write(data);
      }

      delete(gateway.pending[connectionId]);
    });

    socket.on("data", data => McpGateway.sendData(connectionId, Buffer.isBuffer(data) ? data : Buffer.from(data)));
    socket.on("close", () => McpGateway.closeRemote(connectionId));
    socket.on("error", () => socket.destroy());
    gateway.sockets[connectionId] = socket;
    gateway.pending[connectionId] ||= [];
  }

  static onData(connectionId: string, data: string): void {
    const gateway = McpGateway.active;
    const socket = gateway?.sockets[connectionId];
    const chunk = Buffer.from(data, "base64");

    if (!gateway) {
      McpGateway.closeRemote(connectionId);
    } else if (!socket || socket.connecting) {
      (gateway.pending[connectionId] ||= []).push(chunk);
    } else {
      socket.write(chunk);
    }
  }

  static onClose(connectionId: string): void {
    const gateway = McpGateway.active;

    gateway?.sockets[connectionId]?.destroy();

    if (gateway) {
      delete(gateway.sockets[connectionId]);
      delete(gateway.pending[connectionId]);
    }
  }

  private async startGateway(): Promise<string> {
    this.proxyPort = await this.startHttpServer();
    const port = await Emit.share("envim:api", "nvim_call_function", ["EnvimMcpTunnelStart", []]);

    if (typeof port !== "number" || port <= 0) {
      throw new Error("Neovim did not return a valid MCP tunnel port");
    }

    return `http://${GATEWAY_HOST}:${port}`;
  }

  private startHttpServer(): Promise<number> {
    if (this.httpServer) {
      return Promise.resolve((this.httpServer.address() as AddressInfo).port);
    }

    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) =>
        this.onHttpRequest(req, res).catch(() => {
          McpGateway.writeError(res, 500, "Internal error");
        })
      );

      server.once("error", reject);
      server.listen(0, GATEWAY_HOST, () => {
        server.removeListener("error", reject);
        server.on("error", () => {});
        this.httpServer = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private async onHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstreamId = McpGateway.upstreamIdFrom(req.url);

    if (!upstreamId) {
      return McpGateway.writeError(res, 404, "Unknown MCP endpoint");
    }

    let upstream: IMcpUpstream;

    try {
      upstream = this.registry.get(upstreamId);
    } catch {
      return McpGateway.writeError(res, 404, "Unknown MCP endpoint");
    }

    const body = req.method === "POST" ? await McpGateway.readBody(req) : undefined;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (session && session.upstreamId !== upstreamId) {
      return McpGateway.writeError(res, 400, "Invalid session endpoint");
    }

    if (!session && req.method === "POST" && McpTypes.isInitializeRequest(body)) {
      session = { upstreamId, transport: await this.createSession(upstream) };
    }

    if (!session) {
      return McpGateway.writeError(res, 400, "No valid session");
    }

    await session.transport.handleRequest(req, res, body);
  }

  private async createSession(upstream: IMcpUpstream): Promise<StreamableHTTPServerTransport> {
    const capabilities = upstream.client.getServerCapabilities() || {};
    const server = new Server({ name: `envim-proxy:${upstream.name}`, version: "1.0.0" }, { capabilities });
    let transport: StreamableHTTPServerTransport;

    server.setRequestHandler(McpTypes.ListToolsRequestSchema, request => upstream.client.listTools(request.params));
    server.setRequestHandler(McpTypes.CallToolRequestSchema, async request => {
      const result = await upstream.client.callTool(request.params);
      const appResult = McpTypes.CallToolResultSchema.safeParse(result);

      if (appResult.success) {
        Promise.resolve(this.onToolResult(upstream.id, request.params, appResult.data)).catch(() => {});
      }

      return result;
    });
    server.fallbackRequestHandler = request =>
      upstream.client.request({ method: request.method, params: request.params }, McpTypes.ResultSchema);
    server.fallbackNotificationHandler = notification => upstream.client.notification(notification);

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        this.sessions.set(sessionId, { upstreamId: upstream.id, transport });
      },
      onsessionclosed: sessionId => {
        this.sessions.delete(sessionId);
      },
    });

    await server.connect(transport);

    return transport;
  }

  private static upstreamIdFrom(url: string | undefined): string | null {
    const encoded = (url || "").match(/^\/mcp\/([^/?]+)/)?.[1];

    if (!encoded) {
      return null;
    }

    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
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
    if (res.headersSent) {
      return;
    }

    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  }

  private static sendData(connectionId: string, data: Buffer): void {
    Emit.share("envim:api", "nvim_call_function", ["EnvimMcpTunnelWrite", [connectionId, data.toString("base64")]]);
  }

  private static closeRemote(connectionId: string): void {
    const gateway = McpGateway.active;

    if (gateway) {
      delete(gateway.sockets[connectionId]);
      delete(gateway.pending[connectionId]);
    }

    Emit.share("envim:api", "nvim_call_function", ["EnvimMcpTunnelClose", [connectionId]]);
  }

  private switchWorkspace(): void {
    for (const socket of Object.values(this.sockets)) {
      socket.removeAllListeners();
      socket.destroy();
    }

    this.pending = {};
    this.sockets = {};
    this.startPromise = null;
  }
}
