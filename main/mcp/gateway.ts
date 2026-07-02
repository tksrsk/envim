import { randomUUID } from "crypto";
import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "http";
import { AddressInfo, createConnection, Socket } from "net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as McpTypes from "@modelcontextprotocol/sdk/types.js";

import { McpAppService } from "main/mcp/app";
import { McpUpstream, McpUpstreamRegistry } from "main/mcp/upstream";
import { Workspace } from "main/envim/workspace";

interface IMcpGatewaySession {
  upstreamId: string;
  transport: StreamableHTTPServerTransport;
}

const GATEWAY_HOST = "127.0.0.1";

export class McpGateway {
  private httpServer: HttpServer | null = null;
  private pending: { [connectionId: string]: Buffer[] } = {};
  private proxyPort = 0;
  private sessions = new Map<string, IMcpGatewaySession>();
  private sockets: { [connectionId: string]: Socket } = {};
  private startPromise: Promise<string> | null = null;
  public readonly app: McpAppService;
  public readonly upstreams: McpUpstreamRegistry;

  constructor(public readonly workspace: Workspace) {
    this.app = new McpAppService(this.workspace);
    this.upstreams = new McpUpstreamRegistry(this.app, this.workspace.emit);
    this.workspace.emit.share("envim:luafile", "mcp.lua");
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

  onOpen(connectionId: string): void {
    if (!this.proxyPort) {
      this.closeRemote(connectionId);
      return;
    }

    const socket = createConnection({ host: GATEWAY_HOST, port: this.proxyPort }, () => {
      for (const data of this.pending[connectionId] || []) {
        socket.write(data);
      }

      delete(this.pending[connectionId]);
    });

    socket.on("data", data => this.sendData(connectionId, Buffer.isBuffer(data) ? data : Buffer.from(data)));
    socket.on("close", () => this.closeRemote(connectionId));
    socket.on("error", () => socket.destroy());
    this.sockets[connectionId] = socket;
    this.pending[connectionId] ||= [];
  }

  onData(connectionId: string, data: string): void {
    const socket = this.sockets[connectionId];
    const chunk = Buffer.from(data, "base64");

    if (!socket || socket.connecting) {
      (this.pending[connectionId] ||= []).push(chunk);
    } else {
      socket.write(chunk);
    }
  }

  onClose(connectionId: string): void {
    this.sockets[connectionId]?.destroy();

    delete(this.sockets[connectionId]);
    delete(this.pending[connectionId]);
  }

  private async startGateway(): Promise<string> {
    this.proxyPort = await this.startHttpServer();
    const port = await this.workspace.emit.share("envim:function", "EnvimMcpTunnelStart", []);

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

    let upstream: McpUpstream;

    try {
      upstream = this.upstreams.get(upstreamId);
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

  private async createSession(upstream: McpUpstream): Promise<StreamableHTTPServerTransport> {
    const capabilities = upstream.client.getServerCapabilities() || {};
    const server = new Server({ name: `envim-proxy:${upstream.name}`, version: "1.0.0" }, { capabilities });
    let transport: StreamableHTTPServerTransport;

    server.setRequestHandler(McpTypes.ListToolsRequestSchema, request => upstream.client.listTools(request.params));
    server.setRequestHandler(McpTypes.CallToolRequestSchema, async request => {
      const result = await upstream.client.callTool(request.params);
      const appResult = McpTypes.CallToolResultSchema.safeParse(result);

      if (appResult.success) {
        this.app.getToolResource(upstream, request.params.name).then(resource => {
          resource && this.workspace.emit.send("mcp-apps:render", {
            upstreamId: upstream.id, server: upstream.name, tool: request.params.name,
            request: request.params, resource, result: appResult.data,
          });
        }).catch(() => {});
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

  private sendData(connectionId: string, data: Buffer): void {
    this.workspace.emit.share("envim:function", "EnvimMcpTunnelWrite", [connectionId, data.toString("base64")]);
  }

  private closeRemote(connectionId: string): void {
    delete(this.sockets[connectionId]);
    delete(this.pending[connectionId]);

    this.workspace.emit.share("envim:function", "EnvimMcpTunnelClose", [connectionId]);
  }

  dispose(): void {
    this.upstreams.sync([]).catch(() => {});

    for (const socket of Object.values(this.sockets)) {
      socket.removeAllListeners();
      socket.destroy();
    }

    this.pending = {};
    this.sockets = {};
    this.sessions.clear();

    this.httpServer?.closeAllConnections();
    this.httpServer?.close();
    this.httpServer = null;
    this.startPromise = null;
  }
}
