import * as AcpSDK from "@agentclientprotocol/sdk/unstable";

import { Workspace } from "main/envim/workspace";
import { BROWSER_TOOLS_SERVER_NAME } from "main/mcp/browsertools";
import { Setting } from "main/setting";

type HttpMcpServer = Extract<AcpSDK.McpServer, { type: "http" }>;

export class Mcp {
  private static syncPromise: Promise<void> = Promise.resolve();

  static servers(workspace: Workspace, previewId?: string): Promise<AcpSDK.McpServer[]> {
    const operation = Mcp.syncPromise.then(() => Mcp.syncServers(workspace, previewId));

    Mcp.syncPromise = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private static async syncServers(workspace: Workspace, previewId?: string): Promise<AcpSDK.McpServer[]> {
    const servers = (Setting.get()?.acp?.mcpServers || [])
      .filter(mcp => mcp.enabled)
      .map(mcp => mcp.server);
    const httpServers = servers.filter(Mcp.isHttpServer);
    const gateway = workspace.mcpGateway;

    const upstreams = await gateway.upstreams.sync(httpServers);
    gateway.app.onUpstreamsChanged([...upstreams.values()].map(upstream => upstream.id));
    if (!previewId && httpServers.length === 0) return servers;

    let gatewayUrl: string;

    try {
      gatewayUrl = await gateway.start();
    } catch {
      return servers;
    }

    const configuredServers = servers.map<AcpSDK.McpServer>(server => {
      const upstream = upstreams.get(server);

      if (!upstream) return server;

      const url = `${gatewayUrl}/mcp/${encodeURIComponent(upstream.id)}`;

      return { type: "http", name: server.name, url, headers: [] };
    });

    if (previewId) {
      const endpoint = gateway.browser.create(previewId);
      configuredServers.push({ type: "http", name: BROWSER_TOOLS_SERVER_NAME, url: `${gatewayUrl}/mcp/${endpoint}`, headers: [] });
    }

    return configuredServers;
  }

  private static isHttpServer(server: AcpSDK.McpServer): server is HttpMcpServer {
    return "type" in server && server.type === "http";
  }
}
