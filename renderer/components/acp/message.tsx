import React from "react";
import * as AcpSDK from "@agentclientprotocol/sdk";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHilight from "rehype-highlight";
import { diffLines } from "diff";

import { IPermissionRequest } from "common/interface";

import { Emit } from "renderer/utils/emit";
import { icons } from "renderer/utils/icons";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { CollapseComponent } from "renderer/components/collapse";

const styles: { [k: string]: React.CSSProperties } = {
  permission: {
    flexBasis: "100%",
  }
};

const MessageMemo = React.memo(({ message }: { message: AcpSDK.SessionNotification }) => {
  function renderFile(file: string) {
    const icon = icons.find(icon => file.match(icon.match))!;

    return <IconComponent font={icon.font} color={`${icon.color}-fg`} text={file} onClick={() => Emit.send("envim:command", `edit ${file}`)} />;
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

  function handlePermissionChoice(requestId: string, optionId: string) {
    Emit.send("acp:permission-response", requestId, optionId);
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
        {renderFile(path)}
        <FlexComponent>
          {added > 0 && <span className="color-green-fg" style={{padding: "0 2px"}}>+{added}</span>}
          {removed > 0 && <span className="color-red-fg" style={{padding: "0 2px"}}>-{removed}</span>}
        </FlexComponent>
        <div className="selectable">
          <FlexComponent overflow="auto">
            <FlexComponent position="absolute" inset={[0]}>
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]}>
                {`\`\`\`diff\n${signs.join("\n")}\n\`\`\``}
              </Markdown>
            </FlexComponent>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]}>
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
        return <div className="selectable"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]}>{content.text}</Markdown></div>;
      case "image":
        return <img src={content.uri || `data:${content.mimeType};base64,${content.data}`} />;
      case "resource":
        return <div style={{ whiteSpace: "pre-wrap" }}>[resource: {content.resource.uri}]</div>;
      case "resource_link":
        const { pathname } = new URL(content.uri);
        return pathname && renderFile(pathname);
      default:
        return null;
    }
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
      const input = ((input?: unknown) => {
        const json = (() => {
          try {
            if (typeof input === "object") return input;
            if (typeof input === "string") return JSON.parse(input);
          } catch {
            return;
          }
        })();

        if (json && Object.keys(json).length) return `\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;

        return !json && input && typeof input === "string" ? `\`\`\`\n${input}\n\`\`\`` : "";
      })(message.update.rawInput);

      return (
        <>
          <CollapseComponent
            label={message.update.title || message.update.kind || message.update.toolCallId}
            badge={() => <>{typeof message.update._meta?.executionTime === "string" && `${message.update._meta?.executionTime}s`}{icon}</>}
          >
            {input && (
              <CollapseComponent label=" INPUT" style={{marginBottom: 4}}>
                <div className="selectable" style={{ margin: 4 }}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]}>{input}</Markdown></div>
              </CollapseComponent>
            )}
            {message.update.content?.map(renderToolCallContent)}
          </CollapseComponent>
          {permissionRequest && (
            <FlexComponent color="default" horizontal="center">
              {permissionRequest.options.map(option => (
                <FlexComponent key={option.optionId} border={[1]} color={getPermissionIcon(option.kind).color} margin={[4]} padding={[4]} rounded={[4]} shrink={1} title={option.name} style={styles.permission}
                  onClick={() => handlePermissionChoice(permissionRequest!.requestId, option.optionId)}
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
