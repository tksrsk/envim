import * as McpAppBridge from "@modelcontextprotocol/ext-apps/app-bridge";
import React from "react";

import { IMcpApp } from "common/interface";

import { Emit } from "renderer/utils/emit";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";

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
  };
}

const McpAppFrame = React.memo(({ app, sessionId }: { app: IMcpApp; sessionId: string }) => {
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
    nextBridge.oncalltool = params => Emit.send("mcp-apps:call-tool", app.upstreamId, params);
    nextBridge.onlistresources = params => Emit.send("mcp-apps:list-resources", app.upstreamId, params);
    nextBridge.onlistresourcetemplates = params => Emit.send("mcp-apps:list-resource-templates", app.upstreamId, params);
    nextBridge.onreadresource = params => Emit.send("mcp-apps:read-resource", app.upstreamId, params);
    nextBridge.onmessage = async (params: McpAppBridge.McpUiMessageRequest["params"]) => {
      const text = params.content.filter(c  => c.type === "text").map(c => c.text).join("\n");

      text && Emit.send("acp:send-prompt", sessionId, text, [], []);

      return {};
    };
    nextBridge.oninitialized = () => activeBridge.current === nextBridge && setBridge(nextBridge);

    nextBridge.connect(new McpAppBridge.PostMessageTransport(contentWindow, contentWindow))
      .then(() => nextBridge.sendSandboxResourceReady({ html: app.resource.text }))
      .catch(error => console.error("Failed to connect MCP App bridge", error));
  }, [app.resource.text, app.upstreamId, sessionId]);

  React.useEffect(() => {
    const onToolsChanged = (upstreamId: string) => upstreamId === app.upstreamId && activeBridge.current?.sendToolListChanged();
    const onResourcesChanged = (upstreamId: string) => upstreamId === app.upstreamId && activeBridge.current?.sendResourceListChanged();

    Emit.on("mcp-apps:tools-changed", onToolsChanged);
    Emit.on("mcp-apps:resources-changed", onResourcesChanged);

    return () => {
      Emit.off("mcp-apps:tools-changed", onToolsChanged);
      Emit.off("mcp-apps:resources-changed", onResourcesChanged);
      const closingBridge = activeBridge.current;

      activeBridge.current = null;
      setBridge(current => current === closingBridge ? null : current);
      closingBridge?.close().catch(() => {});
    };
  }, [app.upstreamId]);

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

interface Props {
  app: IMcpApp;
  sessionId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export const McpAppComponent = React.memo(({ app, sessionId, open, onOpen, onClose }: Props) => {
  const dialog = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    open ? dialog.current?.showModal() : dialog.current?.close();
  }, [open]);

  return (
    <FlexComponent color="default" border={[1]} rounded={[4]} margin={[2, 0]} padding={[4]} vertical="center">
      <IconComponent color="gray-fg" font="" text={`${app.server} / ${app.tool}`} onClick={onOpen} />
      <dialog className="color-default" ref={dialog} onClose={onClose}>
        <FlexComponent position="absolute" inset={[8, 8, "auto", "auto"]}><IconComponent color="gray-fg" font="" onClick={onClose} /></FlexComponent>
        <McpAppFrame app={app} sessionId={sessionId} />
      </dialog>
    </FlexComponent>
  );
});

export const McpAppsComponent = React.memo(({ apps, sessionId }: { apps: (IMcpApp & { id: string; sessionId: string })[]; sessionId: string; }) => {
  const knownIds = React.useRef(new Set<string>());
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const added = apps.filter(app => !knownIds.current.has(app.id));
    const latest = added.filter(app => app.sessionId === sessionId).at(-1);

    apps.forEach(app => knownIds.current.add(app.id));
    setActiveId(active => latest?.id || (apps.some(app => app.id === active && app.sessionId === sessionId) ? active : null));
  }, [apps, sessionId]);

  return (
    <>
      {apps.map(app => app.sessionId !== sessionId ? null : (
        <FlexComponent key={app.id} animate="fade-in" direction="column" padding={[4, 2]}>
          <McpAppComponent app={app} sessionId={sessionId} open={activeId === app.id} onOpen={() => setActiveId(app.id)} onClose={() => setActiveId(active => active === app.id ? null : active)} />
        </FlexComponent>
      ))}
    </>
  );
});
