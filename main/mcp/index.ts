import * as AcpSDK from "@agentclientprotocol/sdk";

import { Workspace } from "main/envim/workspace";
import { Setting } from "main/setting";

type HttpMcpServer = Extract<AcpSDK.McpServer, { type: "http" | "sse" }>;

export class Mcp {
  private static syncPromise: Promise<void> = Promise.resolve();

  static servers(workspace: Workspace): Promise<AcpSDK.McpServer[]> {
    const operation = Mcp.syncPromise.then(() => Mcp.syncServers(workspace));

    Mcp.syncPromise = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private static async syncServers(workspace: Workspace): Promise<AcpSDK.McpServer[]> {
    const servers = (Setting.get()?.acp?.mcpServers || [])
      .filter(mcp => mcp.enabled)
      .map(mcp => mcp.server);
    const httpServers = servers.filter(Mcp.isHttpServer);
    const gateway = workspace.mcpGateway;

    if (httpServers.length === 0) {
      await gateway.upstreams.sync([]);
      gateway.app.onUpstreamsChanged([]);

      return servers;
    }

    const upstreams = await gateway.upstreams.sync(httpServers);
    gateway.app.onUpstreamsChanged([...upstreams.values()].map(upstream => upstream.id));
    let gatewayUrl: string;

    try {
      gatewayUrl = await gateway.start();
    } catch {
      return servers;
    }

    return servers.map(server => {
      const upstream = upstreams.get(server);

      if (!upstream) return server;

      const url = `${gatewayUrl}/mcp/${encodeURIComponent(upstream.id)}`;

      return { type: "http", name: server.name, url, headers: [] };
    });
  }

  private static isHttpServer(server: AcpSDK.McpServer): server is HttpMcpServer {
    return "type" in server && (server.type === "http" || server.type === "sse");
  }
}
