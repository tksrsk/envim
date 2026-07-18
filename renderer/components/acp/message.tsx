import React from "react";
import * as AcpSDK from "@agentclientprotocol/sdk";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHilight from "rehype-highlight";
import { diffLines } from "diff";

import { IPermissionRequest } from "common/interface";

import { useWorkspace } from "renderer/context/workspace";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { CollapseComponent } from "renderer/components/collapse";

const styles: { [k: string]: React.CSSProperties } = {
  permission: {
    flexBasis: "100%",
  }
};

const MessageMemo = React.memo(({ message }: { message: AcpSDK.SessionNotification }) => {
  const { emit } = useWorkspace();

  function urlTransform(url: string) {
    if (/^(data:|file:\/\/)/.test(url)) return url;
    return defaultUrlTransform(url);
  }

  function getStatusIcon(status?: string | null) {
    switch (status) {
      case "pending": return <IconComponent color="gray-fg" font="󰐎" />;
      case "in_progress": return <div className="animate loading inline" style={{margin: "0 4px"}} />;
      case "completed": return <IconComponent color="green-fg" font="" />;
      case "failed": return <IconComponent font="" color="red-fg" />;
      default: return null;
    }
  }

  function onAcpPermissionChoice(requestId: string, optionId: string) {
    emit.send("acp:permission:response", requestId, optionId);
  }

  function getPermissionIcon(kind: string, suffix: string = "") {
    switch (kind) {
      case "allow_once":
      case "allow_always":
        return { color: `green${suffix}`, font: "" };
      case "reject_once":
      case "reject_always":
        return { color: `red${suffix}`, font: "" };
      default:
        return { color: `blue${suffix}`, font: "" };
    }
  }

  function renderDiffLines(path: string, oldText: string, newText: string) {
    const diff = diffLines(oldText, newText);
    const [signs, lines, fence, added, removed] = diff.reduce<[string[], string[], string, number, number]>(([signs, lines, fence, added, removed], change) => {
      const parts = change.value.split("\n").filter(line => line);
      const sign = change.added ? "+" : change.removed ? "-" : " ";
      const maxRun = Math.max(0, ...(change.value.match(/`+/g) || []).map(m => m.length));

      signs.push(...parts.map(() => sign));
      lines.push(...parts);
      [ added, removed ] = [added + (change.added ? parts.length : 0), removed + (change.removed ? parts.length : 0)]

      return [signs, lines, maxRun >= fence.length ? "`".repeat(maxRun + 1) : fence, added, removed];
    }, [[], [], "```", 0, 0]);

    return (
      <>
        <a href={`file://${path}`}>{path}</a>
        <FlexComponent>
          {added > 0 && <span className="color-green-fg" style={{padding: "0 2px"}}>+{added}</span>}
          {removed > 0 && <span className="color-red-fg" style={{padding: "0 2px"}}>-{removed}</span>}
        </FlexComponent>
        <div className="selectable">
          <FlexComponent overflow="auto">
            <FlexComponent position="absolute" inset={[0]}>
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>
                {`\`\`\`diff\n${signs.join("\n")}\n\`\`\``}
              </Markdown>
            </FlexComponent>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>
              {`${fence}${path.split(".").pop() || ""}\n${lines.join("\n")}\n${fence}`}
            </Markdown>
          </FlexComponent>
        </div>
      </>
    );
  }

  function renderToolCallContent(content: AcpSDK.ToolCallContent) {
    switch (content.type) {
      case "content":
        return renderContent(content.content);
      case "diff":
        return renderDiffLines(content.path, content.oldText || "", content.newText || "") ;
      case "terminal":
      default:
        return null;
    }
  }

  function renderContent(content: AcpSDK.ContentBlock) {
    switch (content.type) {
      case "text":
        return <div className="selectable"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>{content.text}</Markdown></div>;
      case "image":
        return <img src={content.uri || `data:${content.mimeType};base64,${content.data}`} />;
      case "resource":
        return <div style={{ whiteSpace: "pre-wrap" }}>[resource: {content.resource.uri}]</div>;
      case "resource_link":
        return <a href={content.uri}>{(new URL(content.uri)).pathname}</a>;
      default:
        return null;
    }
  }

  function formatToolData(data?: unknown) {
    const json = (() => {
      try {
        if (data !== null && typeof data === "object") return data;
        if (typeof data === "string") return JSON.parse(data);
      } catch {
        return;
      }
    })();

    if (json && Object.keys(json).length) return `\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;

    return !json && data && typeof data === "string" ? `\`\`\`\n${data}\n\`\`\`` : "";
  }

  switch (message.update.sessionUpdate) {
    case "user_message_chunk":
      const content = renderContent(message.update.content);
      return message.update.content.type !== "text" ? content : (
        <FlexComponent direction="column" color="lightblue" padding={[8]} rounded={[4]} shadow>{content}</FlexComponent>
      );
    case "agent_message_chunk":
      return renderContent(message.update.content);
    case "agent_thought_chunk":
      return <CollapseComponent label="󰟶 Agent Thought...">{renderContent(message.update.content)}</CollapseComponent>;
    case "tool_call":
    case "tool_call_update":
      const permissionRequest = message.update._meta?.permissionRequest as IPermissionRequest | undefined;
      const icon = getStatusIcon(message.update.status);
      const input = formatToolData(message.update.rawInput);
      const output = formatToolData(message.update.rawOutput);

      return (
        <>
          <CollapseComponent
            label={message.update.title || message.update.kind || message.update.toolCallId}
            badge={() => <>{typeof message.update._meta?.executionTime === "string" && `${message.update._meta?.executionTime}s`}{icon}</>}
          >
            {input && (
              <CollapseComponent label=" INPUT" style={{marginBottom: 4}}>
                <div className="selectable" style={{ margin: 4 }}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>{input}</Markdown></div>
              </CollapseComponent>
            )}
            {output && (
              <CollapseComponent label=" OUTPUT" style={{marginBottom: 4}}>
                <div className="selectable" style={{ margin: 4 }}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>{output}</Markdown></div>
              </CollapseComponent>
            )}
            {message.update.content?.map(renderToolCallContent)}
          </CollapseComponent>
          {permissionRequest && (
            <FlexComponent color="default" horizontal="center">
              {permissionRequest.options.map(option => (
                <FlexComponent key={option.optionId} border={[1]} color={getPermissionIcon(option.kind).color} margin={[4]} padding={[4]} rounded={[4]} shrink={1} title={option.name} style={styles.permission}
                  onClick={() => onAcpPermissionChoice(permissionRequest!.requestId, option.optionId)}
                >
                  <IconComponent {...getPermissionIcon(option.kind, "-fg")} text={option.name} />
                </FlexComponent>
              ))}
            </FlexComponent>
          )}
        </>
      );
  }

  return null;
});

export const MessageComponent = React.memo(({ messages, sessionId }: { messages: AcpSDK.SessionNotification[]; sessionId: string; }) => (
  <>
    {messages.map((message, i) => message.sessionId !== sessionId ? null : (
      <FlexComponent key={`message_${i}`} animate="fade-in" direction="column" padding={[4, 2]}>
        <MessageMemo message={message} />
      </FlexComponent>
    ))}
  </>
));
