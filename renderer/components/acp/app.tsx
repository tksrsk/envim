import * as McpAppBridge from "@modelcontextprotocol/ext-apps/app-bridge";
import React from "react";

import { IMcpApp } from "common/interface";

import { useWorkspace } from "renderer/context/workspace";

import { Emit } from "renderer/utils/emit";

import { FlexComponent } from "renderer/components/flex";
import { CollapseComponent } from "renderer/components/collapse";
import { DialogComponent } from "renderer/components/dialog";

const SANDBOX_PROXY_HTML = `<!doctype html>
<html>
  <body style="margin:0;overflow:hidden">
    <script>
      const inner = document.createElement("iframe");
      inner.style = "width:100vw;height:100vh;border:0";
      inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      document.body.appendChild(inner);
      window.addEventListener("message", event => {
        if (event.source === window.parent) {
          if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
            const { html, sandbox } = event.data.params || {};
            if (typeof sandbox === "string") inner.setAttribute("sandbox", sandbox);
            if (typeof html === "string") inner.srcdoc = html;
          } else {
            inner.contentWindow?.postMessage(event.data, "*");
          }
        } else if (event.source === inner.contentWindow) {
          window.parent.postMessage(event.data, "*");
        }
      });
    </script>
  </body>
</html>`;

function getHostContext(element: HTMLElement): McpAppBridge.McpUiHostContext {
  const computed = getComputedStyle(element);

  return {
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { width: element.clientWidth, height: element.clientHeight },
    displayMode: element.closest("dialog")?.open ? "fullscreen" : "inline",
    platform: "desktop",
    theme: element.closest(".theme-light") ? "light" : "dark",
    styles: {
      variables: {
        "--color-background-primary": computed.getPropertyValue("--color-bg"),
        "--color-background-secondary": computed.getPropertyValue("--color-gray-alpha"),
        "--color-border-primary": computed.getPropertyValue("--color-gray"),
        "--color-text-primary": computed.getPropertyValue("--color-fg"),
        "--color-text-secondary": computed.getPropertyValue("--color-gray"),
        "--color-text-info": computed.getPropertyValue("--color-blue"),
        "--color-text-danger": computed.getPropertyValue("--color-red"),
        "--color-text-success": computed.getPropertyValue("--color-green"),
        "--color-text-warning": computed.getPropertyValue("--color-yellow"),
        "--border-radius-sm": "4px",
      },
    },
  } as McpAppBridge.McpUiHostContext;
}

const McpAppFrame = React.memo(({ app, sessionId, onClose }: { app: IMcpApp; sessionId: string; onClose: () => void }) => {
  const { emit } = useWorkspace();
  const iframe = React.useRef<HTMLIFrameElement>(null);
  const sendQueue = React.useRef<Promise<void>>(Promise.resolve());
  const activeBridge = React.useRef<McpAppBridge.AppBridge | null>(null);
  const [bridge, setBridge] = React.useState<McpAppBridge.AppBridge | null>(null);

  const onLoad = React.useCallback(() => {
    const contentWindow = iframe.current?.contentWindow;

    if (!contentWindow) return;

    activeBridge.current?.close().catch(() => {});

    const nextBridge = new McpAppBridge.AppBridge(
      null,
      { name: "Envim", version: "1.0.0" },
      { serverResources: { listChanged: true }, serverTools: { listChanged: true }, message: {} },
      { hostContext: getHostContext(iframe.current!) }
    );
    activeBridge.current = nextBridge;
    nextBridge.oncalltool = params => emit.send(`mcp:tool:call:${app.upstreamId}`, params);
    nextBridge.onlistresources = params => emit.send(`mcp:resources:list:${app.upstreamId}`, params);
    nextBridge.onlistresourcetemplates = params => emit.send(`mcp:resource:templates:list:${app.upstreamId}`, params);
    nextBridge.onreadresource = params => emit.send(`mcp:resource:read:${app.upstreamId}`, params);
    nextBridge.onmessage = async (params: McpAppBridge.McpUiMessageRequest["params"]) => {
      const text = params.content.filter(c  => c.type === "text").map(c => c.text).join("\n");

      if (text) {
        emit.send("acp:prompt:send", sessionId, text, [], []);
        onClose();
      }

      return {};
    };
    nextBridge.oninitialized = () => activeBridge.current === nextBridge && setBridge(nextBridge);

    nextBridge.connect(new McpAppBridge.PostMessageTransport(contentWindow, contentWindow))
      .then(() => nextBridge.sendSandboxResourceReady({ html: app.resource.text }))
      .catch(error => console.error("Failed to connect MCP App bridge", error));
  }, [app.resource.text, app.upstreamId, sessionId, onClose, emit]);

  React.useEffect(() => {
    const onMcpResourcesChanged = (upstreamId: string) => upstreamId === app.upstreamId && activeBridge.current?.sendResourceListChanged();
    const onMcpToolsChanged = (upstreamId: string) => upstreamId === app.upstreamId && activeBridge.current?.sendToolListChanged();

    emit.on("mcp:resources:changed", onMcpResourcesChanged);
    emit.on("mcp:tools:changed", onMcpToolsChanged);

    return () => {
      emit.off("mcp:resources:changed", onMcpResourcesChanged);
      emit.off("mcp:tools:changed", onMcpToolsChanged);
      const closingBridge = activeBridge.current;

      activeBridge.current = null;
      setBridge(current => current === closingBridge ? null : current);
      closingBridge?.close().catch(() => {});
    };
  }, [app.upstreamId, emit]);

  React.useEffect(() => {
    if (!bridge || !iframe.current) return;

    const updateHostContext = () => iframe.current && bridge.setHostContext(getHostContext(iframe.current));
    const resize = new ResizeObserver(updateHostContext);

    Emit.on("app:theme", updateHostContext);
    resize.observe(iframe.current);

    return () => {
      Emit.off("app:theme", updateHostContext);
      resize.disconnect();
    };
  }, [bridge]);

  React.useEffect(() => {
    if (!bridge) return;

    sendQueue.current = sendQueue.current
      .then(() => bridge.sendToolInput({ arguments: app.request.arguments || {} }))
      .then(() => bridge.sendToolResult(app.result))
      .catch(error => console.error("Failed to update MCP App", error));
  }, [app.request, app.result, bridge]);

  return <iframe ref={iframe} onLoad={onLoad} sandbox="allow-scripts" srcDoc={SANDBOX_PROXY_HTML} />;
});

export function McpAppsComponent({ sessionId }: { sessionId: string }) {
  const [apps, setApps] = React.useState<(IMcpApp & { id: string })[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const { emit } = useWorkspace();
  const filtered = apps.filter(a => a.id.startsWith(sessionId));
  const onClose = React.useCallback(() => setActiveId(null), []);

  React.useEffect(() => {
    emit.on("mcp:render", onMcpRender);

    return () => {
      emit.off("mcp:render", onMcpRender);
    };
  }, [sessionId]);

  function onMcpRender(app: IMcpApp) {
    setApps(apps => {
      const id = `${sessionId}_${app.upstreamId}_${app.resource.uri}`
      setActiveId(id);

      return [...apps.filter(app => app.id !== id), { ...app, id }];
    });
  };

  return filtered.length === 0 ? null : (
    <CollapseComponent label="󱘍 Apps" badge={`${filtered.length}`} style={{marginBottom: 4}} open>
      {filtered.map(app => (
        <React.Fragment key={app.id}>
          <FlexComponent color="purple-fg" onClick={() => setActiveId(app.id)}>{`${app.server} / ${app.tool}`}</FlexComponent>
          <DialogComponent open={activeId === app.id} onClose={onClose}>
            <McpAppFrame app={app} sessionId={sessionId} onClose={onClose} />
          </DialogComponent>
        </React.Fragment>
      ))}
    </CollapseComponent>
  );
}
