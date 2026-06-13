import { createConnection, Socket } from "net";

import { Emit } from "main/emit";

const PROXY_HOST = "127.0.0.1";

export class McpTunnel {
  private static url = "";
  private static proxyPort = 0;
  private static sockets: { [connectionId: string]: Socket } = {};
  private static pending: { [connectionId: string]: Buffer[] } = {};

  static setup(): void {
    Emit.share("envim:luafile", "mcp.lua");
  }

  static async start(proxyPort: number): Promise<string> {
    McpTunnel.proxyPort = proxyPort;

    const port = await Emit.share(
      "envim:api",
      "nvim_call_function",
      ["EnvimMcpTunnelStart", []]
    );

    if (typeof port !== "number" || port <= 0) {
      throw new Error("Neovim did not return a valid MCP tunnel port");
    }

    McpTunnel.url = `http://${PROXY_HOST}:${port}`;

    return McpTunnel.url;
  }

  static getUrl(): string {
    return McpTunnel.url;
  }

  static stop(): void {
    Object.values(McpTunnel.sockets).forEach(socket => socket.destroy());
    McpTunnel.callNeovim("EnvimMcpTunnelStop");

    McpTunnel.sockets = {};
    McpTunnel.pending = {};
    McpTunnel.url = "";
    McpTunnel.proxyPort = 0;
  }

  static handleOpen(connectionId: string): void {
    if (!McpTunnel.proxyPort) {
      McpTunnel.closeRemote(connectionId);
      return;
    }

    // IPC carries the raw TCP bytes; this reconnects them to the main-process HTTP proxy.
    const socket = createConnection({ host: PROXY_HOST, port: McpTunnel.proxyPort }, () => {
      for (const data of McpTunnel.pending[connectionId] || []) {
        socket.write(data);
      }

      delete(McpTunnel.pending[connectionId]);
    });

    socket.on("data", data => McpTunnel.sendData(connectionId, data));
    socket.on("close", () => McpTunnel.closeRemote(connectionId));
    socket.on("error", error => McpTunnel.log(`Tunnel ${connectionId} failed`, error));
    McpTunnel.sockets[connectionId] = socket;
    McpTunnel.pending[connectionId] ||= [];
  }

  static handleData(connectionId: string, data: string): void {
    const socket = McpTunnel.sockets[connectionId];
    const chunk = Buffer.from(data, "base64");

    if (!socket || socket.connecting) {
      (McpTunnel.pending[connectionId] ||= []).push(chunk);
    } else {
      socket.write(chunk);
    }
  }

  static handleClose(connectionId: string): void {
    McpTunnel.sockets[connectionId]?.destroy();
    delete(McpTunnel.sockets[connectionId]);
    delete(McpTunnel.pending[connectionId]);
  }

  static handleError(connectionId: string, error: string): void {
    McpTunnel.log(`Neovim tunnel${connectionId ? ` ${connectionId}` : ""} failed`, error);
  }

  private static sendData(connectionId: string, data: Buffer): void {
    McpTunnel.callNeovim("EnvimMcpTunnelWrite", [connectionId, data.toString("base64")]);
  }

  private static closeRemote(connectionId: string): void {
    delete(McpTunnel.sockets[connectionId]);
    delete(McpTunnel.pending[connectionId]);
    McpTunnel.callNeovim("EnvimMcpTunnelClose", [connectionId]);
  }

  private static callNeovim(name: string, args: unknown[] = []): void {
    Emit.share("envim:api", "nvim_call_function", [name, args]).catch(error => McpTunnel.log(`${name} failed`, error));
  }

  private static log(message: string, error?: unknown): void {
    Emit.send("console:log", `[mcp-tunnel]: ${message}`, error instanceof Error ? error.message : String(error || ""));
  }
}
