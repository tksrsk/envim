import React from "react";
import { ContentBlock, ToolCallContent, SessionNotification } from "@agentclientprotocol/sdk";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHilight from "rehype-highlight";

import { IPermissionRequest } from "common/interface";

import { Emit } from "../../utils/emit";
import { icons } from "../../utils/icons";

import { FlexComponent } from "../flex";
import { IconComponent } from "../icon";

const MessageMemo = React.memo(({ message }: { message: SessionNotification }) => {
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

  function getPermissionColor(kind: string): string {
    switch (kind) {
      case "allow_once":
      case "allow_always":
        return "green";
      case "reject_once":
      case "reject_always":
        return "red";
      default:
        return "blue";
    }
  }

  function renderToolCallContent(content: ToolCallContent) {
    switch (content.type) {
      case "content":
        return renderContent(content.content);
      case "diff":
        return (
          <details>
            <summary className="clickable"> {content.path}</summary>
            <FlexComponent direction="column" padding={[4]}>
              {renderFile(content.path)}
              <FlexComponent color="green" whiteSpace="pre-wrap">{content.newText}</FlexComponent>
              <FlexComponent color="red" whiteSpace="pre-wrap">{content.oldText}</FlexComponent>
            </FlexComponent>
          </details>
        );
      case "terminal":
      default:
        return null;
    }
  }

  function renderContent(content: ContentBlock) {
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
        <FlexComponent direction="column" color="lightblue" margin={[2]} padding={[8]} rounded={[4]} shadow>{content}</FlexComponent>
      );
    case "agent_message_chunk":
      return renderContent(message.update.content);
    case "agent_thought_chunk":
      return (
        <details>
          <summary className="clickable">󰟶 Agent Thought...</summary>
          <FlexComponent direction="column" padding={[4]}>{renderContent(message.update.content)}</FlexComponent>
        </details>
      );
    case "tool_call":
    case "tool_call_update":
      const permissionRequest = message.update._meta?.permissionRequest as IPermissionRequest | undefined;
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
          <details>
            <summary className="clickable">
              <FlexComponent vertical="center" whiteSpace="pre-wrap">
                {message.update.title || message.update.kind || message.update.toolCallId}
                <div className="space" />
                {typeof message.update._meta?.executionTime === "string" && `${message.update._meta?.executionTime}s`}
                {getStatusIcon(message.update.status)}
              </FlexComponent>
            </summary>
            <FlexComponent direction="column" padding={[4]}>
              {input && (
                <details style={{marginBottom: 4}}>
                  <summary className="clickable"> INPUT</summary>
                  <div className="selectable" style={{ margin: 4 }}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]}>{input}</Markdown></div>
                </details>
              )}
              {message.update.content?.map(renderToolCallContent)}
            </FlexComponent>
          </details>
          {permissionRequest && (
            <FlexComponent color="default" horizontal="center">
              {permissionRequest.options.map(option => (
                <FlexComponent key={option.optionId} border={[1]} color={getPermissionColor(option.kind)} margin={[4]} padding={[4]} rounded={[4]}
                  onClick={() => handlePermissionChoice(permissionRequest!.requestId, option.optionId)}
                >
                  {option.name}
                </FlexComponent>
              ))}
            </FlexComponent>
          )}
        </>
      );
  }

  return null;
});

export const MessageComponent = React.memo(({ messages, sessionId }: { messages: SessionNotification[]; sessionId: string; }) => (
  <>
    {messages.map((message, i) => message.sessionId !== sessionId ? null : (
      <FlexComponent key={`message_${i}`} animate="fade-in" direction="column" padding={[4, 2]}>
        <MessageMemo message={message} />
      </FlexComponent>
    ))}
  </>
));
