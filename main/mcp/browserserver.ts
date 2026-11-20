import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "http";
import { AddressInfo } from "net";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";

import { BROWSER_TOOLS_SERVER_NAME, BrowserTools } from "main/mcp/browsertools";
import { MOCK_HEADERS, MOCK_PATH } from "main/mcp/preview";
import type { Workspace } from "main/envim/workspace";

const HOST = "127.0.0.1";
const MCP_PATH = "/mcp/browser";

// Serves the browser tools of a workspace over MCP on a local port, and the mock preview they show.
// Envim registers the tools as an HTTP MCP server, so the MCP gateway forwards them to the agent like
// any other server. The tools keep their state in BrowserTools, so every request gets its own server and transport.
export class BrowserServer {
  public readonly tools: BrowserTools;
  private httpServer?: HttpServer;
  private port?: Promise<number>;

  constructor(workspace: Workspace) {
    this.tools = new BrowserTools(workspace, () => this.origin());
  }

  url(): Promise<string> {
    return this.origin().then(origin => `${origin}${MCP_PATH}`);
  }

  private origin(): Promise<string> {
    this.port ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.onRequest(req, res).catch(() => res.headersSent || res.writeHead(500).end()));

      server.once("error", reject);
      server.listen(0, HOST, () => resolve((server.address() as AddressInfo).port));
      this.httpServer = server;
    }).catch(error => {
      this.port = undefined;
      throw error;
    });

    return this.port.then(port => `http://${HOST}:${port}`);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url?.split("?")[0];
    if (req.method === "GET" && path === MOCK_PATH) {
      const html = this.tools.mock.html;
      if (html === undefined) res.writeHead(404).end(); else res.writeHead(200, MOCK_HEADERS).end(html);
      return;
    }

    // Only Envim's MCP gateway connects to the tools. Browsers send Origin, so pages cannot call them.
    if (req.headers.origin !== undefined || path !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    const server = new Server({ name: BROWSER_TOOLS_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    this.tools.registerTools(server);
    res.on("close", () => void server.close());

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  dispose(): void {
    this.tools.reset();
    this.httpServer?.close();
    this.httpServer?.closeAllConnections();
    this.httpServer = undefined;
    this.port = undefined;
  }
}
