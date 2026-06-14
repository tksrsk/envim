import * as SDK from "@agentclientprotocol/sdk";

import { McpAppService } from "main/mcp/app";
import { McpGateway } from "main/mcp/gateway";
import { McpUpstreamRegistry } from "main/mcp/upstream";
import { Setting } from "main/setting";

interface IMcpServices {
  app: McpAppService;
  gateway: McpGateway;
  registry: McpUpstreamRegistry;
}

type HttpMcpServer = Extract<SDK.McpServer, { type: "http" | "sse" }>;

export class Mcp {
  private static services: IMcpServices | null = null;
  private static syncPromise: Promise<void> = Promise.resolve();

  static servers(): Promise<SDK.McpServer[]> {
    const operation = Mcp.syncPromise.then(() => Mcp.syncServers());

    Mcp.syncPromise = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private static async syncServers(): Promise<SDK.McpServer[]> {
    const servers = (Setting.get()?.acp?.mcpServers || [])
      .filter(mcp => mcp.enabled)
      .map(mcp => mcp.server);
    const httpServers = servers.filter(Mcp.isHttpServer);

    if (httpServers.length === 0) {
      if (Mcp.services) {
        await Mcp.services.registry.sync([]);
        Mcp.services.app.onUpstreamsChanged([]);
      }

      return servers;
    }

    const services = Mcp.ensureServices();
    const upstreams = await services.registry.sync(httpServers);
    services.app.onUpstreamsChanged(upstreams.keys());
    let gatewayUrl: string;

    try {
      gatewayUrl = await services.gateway.start();
    } catch {
      return servers;
    }

    return servers.map(server => {
      if (!Mcp.isHttpServer(server)) {
        return server;
      }

      const upstreamId = McpUpstreamRegistry.idFor(server);

      if (!upstreams.has(upstreamId)) {
        return server;
      }

      return {
        type: "http",
        name: server.name,
        url: services.gateway.urlFor(upstreamId, gatewayUrl),
        headers: [],
      };
    });
  }

  private static ensureServices(): IMcpServices {
    if (Mcp.services) {
      return Mcp.services;
    }

    const registry = new McpUpstreamRegistry({
      onToolsChanged: upstreamId => app.onToolsChanged(upstreamId),
      onResourcesChanged: upstreamId => app.onResourcesChanged(upstreamId),
    });

    const app = new McpAppService(registry);
    const gateway = new McpGateway(registry, (upstreamId, request, result) =>
      app.onToolResult(upstreamId, request, result)
    );

    app.setup();
    Mcp.services = { app, gateway, registry };

    return Mcp.services;
  }

  private static isHttpServer(server: SDK.McpServer): server is HttpMcpServer {
    return "type" in server && (server.type === "http" || server.type === "sse");
  }
}
