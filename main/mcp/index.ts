import * as AcpSDK from "@agentclientprotocol/sdk/unstable";

import { Workspace } from "main/envim/workspace";
import { BROWSER_TOOLS_SERVER_NAME } from "main/mcp/browsertools";
import { Setting } from "main/setting";

type HttpMcpServer = Extract<AcpSDK.McpServer, { type: "http" }>;

export class Mcp {
  private static syncPromise: Promise<void> = Promise.resolve();

  // browser adds the browser tools of the workspace to the servers.
  static servers(workspace: Workspace, browser = false): Promise<AcpSDK.McpServer[]> {
    const operation = Mcp.syncPromise.then(() => Mcp.syncServers(workspace, browser));

    Mcp.syncPromise = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private static async syncServers(workspace: Workspace, browser: boolean): Promise<AcpSDK.McpServer[]> {
    const servers = (Setting.get()?.acp?.mcpServers || [])
      .filter(mcp => mcp.enabled)
      .map(mcp => mcp.server);
    // The browser tools listen on Envim's host, so they reach the agent through the gateway like any HTTP server.
    const browserServer: HttpMcpServer | undefined = browser
      ? await workspace.browser.url().then(url => ({ type: "http", name: BROWSER_TOOLS_SERVER_NAME, url, headers: [] }), () => undefined)
      : undefined;
    const httpServers = [...servers.filter(Mcp.isHttpServer), ...(browserServer ? [browserServer] : [])];
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

    const viaGateway = (server: AcpSDK.McpServer): AcpSDK.McpServer | undefined => {
      const upstream = upstreams.get(server);

      if (!upstream) return undefined;

      const url = `${gatewayUrl}/mcp/${encodeURIComponent(upstream.id)}`;

      return { type: "http", name: server.name, url, headers: [] };
    };
    const browserViaGateway = browserServer && viaGateway(browserServer);

    return [...servers.map(server => viaGateway(server) ?? server), ...(browserViaGateway ? [browserViaGateway] : [])];
  }

  private static isHttpServer(server: AcpSDK.McpServer): server is HttpMcpServer {
    return "type" in server && server.type === "http";
  }
}
