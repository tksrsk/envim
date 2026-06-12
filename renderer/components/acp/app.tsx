import { WebviewTag } from "electron";
import React from "react";

import { IMcpApp } from "common/interface";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { CollapseComponent } from "renderer/components/collapse";

// Encode HTML into a data: URL the sandboxed webview can load. Chunked to avoid
// blowing the call stack on large bundles, and UTF-8 safe.
function toDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return `data:text/html;base64,${btoa(binary)}`;
}

/**
 * Display-only renderer for an MCP App UI resource (SEP-1865 / MCP-UI).
 *
 * The HTML runs in an Electron <webview>, which the main process keeps isolated
 * (no node integration, no preload — see bootstrap `will-attach-webview`). The
 * tool's structured output is injected after load as `window.openai.toolOutput`
 * for Apps-SDK style widgets. The iframe -> host tool-call bridge is intentionally
 * out of scope for this first cut.
 */
export const McpAppComponent = React.memo(({ app }: { app: IMcpApp }) => {
  const container = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!container.current) return;

    const webview = document.createElement("webview") as WebviewTag;
    const onReady = () => {
      if (app.structuredContent !== undefined) {
        const payload = JSON.stringify(app.structuredContent);

        webview.executeJavaScript(`window.openai = Object.assign(window.openai || {}, { toolOutput: ${payload} }); window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: { toolOutput: ${payload} } } }));`).catch(() => {});
      }
    };

    webview.addEventListener("dom-ready", onReady);
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.src = toDataUrl(app.html);
    container.current.appendChild(webview);

    return () => {
      webview.removeEventListener("dom-ready", onReady);
      webview.remove();
    };
  }, [app.html, app.structuredContent]);

  return (
    <CollapseComponent label={`󱂛 ${app.server} / ${app.tool}`} badge={() => <IconComponent color="purple-fg" font="" />} open>
      <FlexComponent color="default" border={[1]} rounded={[4]} margin={[2, 0]} style={{ height: 360 }}>
        <div className="space" ref={container} style={{ width: "100%", height: "100%" }} />
      </FlexComponent>
    </CollapseComponent>
  );
});

export const McpAppsComponent = React.memo(({ apps, sessionId }: { apps: (IMcpApp & { id: string; sessionId: string })[]; sessionId: string; }) => (
  <>
    {apps.map(app => app.sessionId !== sessionId ? null : (
      <FlexComponent key={app.id} animate="fade-in" direction="column" padding={[4, 2]}>
        <McpAppComponent app={app} />
      </FlexComponent>
    ))}
  </>
));
