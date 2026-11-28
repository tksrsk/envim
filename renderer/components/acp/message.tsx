import React from "react";
import { Alert, Box, Button, Group, Loader, Paper, Stack, Tabs } from "@mantine/core";
import * as AcpSDK from "@agentclientprotocol/sdk/unstable";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHilight from "rehype-highlight";
import { diffLines } from "diff";

import { IPermissionRequest, IElicitationRequest, IAcpTerminalOutput } from "common/interface";

import { uiIcons } from "renderer/utils/icons";

import { useWorkspace } from "renderer/context/workspace";

import { CollapseComponent } from "renderer/components/collapse";
import { ElicitationComponent } from "renderer/components/acp/elicitation";

const kindIcons: Record<string, string> = {
  read: "\u{F0219}",
  edit: "\u{F03EB}",
  delete: "\u{F01B4}",
  move: "\u{F04E1}",
  search: "\u{F0349}",
  execute: "\u{F018D}",
  think: "\u{F0336}",
  fetch: "\u{F059F}",
  switch_mode: "\u{F04E1}",
  compact: "\u{F0219}",
  other: "\u{F1064}",
};

const MessageMemo = React.memo(({ message }: { message: AcpSDK.SessionNotification }) => {
  const { emit } = useWorkspace();
  const [toolTab, setToolTab] = React.useState<string | null>(null);

  function urlTransform(url: string) {
    if (/^(data:|file:\/\/)/.test(url)) return url;
    return defaultUrlTransform(url);
  }

  function getKindIcon(kind?: string | null, status?: string | null) {
    if (status === "in_progress") return <Loader size="1em" />;

    const font = kindIcons[kind || "other"] || kindIcons.other;
    const color = status === "failed" ? "red" : status === "pending" ? "yellow" : status === "cancelled" ? "gray" : undefined;

    return <i style={color ? { color: `var(--mantine-color-${color}-text)` } : undefined}>{font}</i>;
  }

  function onAcpPermissionChoice(requestId: string, optionId: string) {
    emit.send("acp:permission:response", requestId, optionId);
  }

  function getPermissionIcon(kind: string) {
    switch (kind) {
      case "allow_once":
      case "allow_always":
        return { color: "green", font: uiIcons.accept };
      case "reject_once":
      case "reject_always":
        return { color: "red", font: uiIcons.decline };
      default:
        return { color: "blue", font: "" };
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
        <Group gap={0}>
          {added > 0 && <Box component="span" c="green" px={2}>+{added}</Box>}
          {removed > 0 && <Box component="span" c="red" px={2}>-{removed}</Box>}
        </Group>
        <div className="selectable">
          <div className="acp-diff">
            <div className="acp-diff-signs">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>
                {`\`\`\`diff\n${signs.join("\n")}\n\`\`\``}
              </Markdown>
            </div>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>
              {`${fence}${path.split(".").pop() || ""}\n${lines.join("\n")}\n${fence}`}
            </Markdown>
          </div>
        </div>
      </>
    );
  }

  function renderTerminal(terminal?: IAcpTerminalOutput) {
    if (!terminal) return null;

    const output = terminal.output.replace(/\n$/, "");
    const maxRun = Math.max(0, ...(output.match(/`+/g) || []).map(m => m.length));
    const fence = "`".repeat(Math.max(3, maxRun + 1));
    const { exitCode, signal } = terminal.exitStatus || {};
    const failed = !!signal || (exitCode !== undefined && exitCode !== null && exitCode !== 0);

    return (
      <>
        <Group gap={0}>
          {terminal.truncated && <Box component="span" c="dimmed" px={2}>(truncated)</Box>}
          {failed && <Box component="span" c="red" px={2}>{signal ? `signal ${signal}` : `exit ${exitCode}`}</Box>}
        </Group>
        {output && (
          <div className="selectable">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>
              {`${fence}\n${output}\n${fence}`}
            </Markdown>
          </div>
        )}
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
        return renderTerminal(((message.update._meta?.terminals || {}) as Record<string, IAcpTerminalOutput>)[content.terminalId]);
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
    case "compaction_update":
      const compaction = message.update;
      const compactionLabel = compaction.status === "in_progress" ? "Compacting context…"
        : compaction.status === "completed" ? "Context compacted"
        : compaction.status === "failed" ? "Context compaction failed"
        : compaction.status === "cancelled" ? "Context compaction cancelled"
        : `Context compaction: ${compaction.status}`;
      return (
        <CollapseComponent variant="row" label={compactionLabel} icon={getKindIcon("compact", compaction.status)}>
          {compaction.error && (
            <Alert variant="light" color="red" p={4} className="selectable" style={{ whiteSpace: "pre-wrap" }}>{compaction.error}</Alert>
          )}
          {compaction.summary?.map((content, i) => <React.Fragment key={i}>{renderContent(content)}</React.Fragment>)}
        </CollapseComponent>
      );
    case "user_message_chunk":
      const content = renderContent(message.update.content);
      return message.update.content.type !== "text" ? content : (
        <Paper className="acp-user-prompt" p="7px 9px" radius={4} bg="var(--mantine-color-cyan-light)">{content}</Paper>
      );
    case "agent_message_chunk":
      return renderContent(message.update.content);
    case "agent_thought_chunk":
      return <CollapseComponent variant="row" label="Thinking…" icon={getKindIcon("think")}>{renderContent(message.update.content)}</CollapseComponent>;
    case "tool_call":
    case "tool_call_update":
      const permissionRequest = message.update._meta?.permissionRequest as IPermissionRequest | undefined;
      const elicitationRequest = message.update._meta?.elicitationRequest as IElicitationRequest | undefined;
      const input = formatToolData(message.update.rawInput);
      const output = formatToolData(message.update.rawOutput);
      const toolContent = message.update.content;
      const hasContent = !!toolContent?.length;
      const availableTabs = [hasContent && "content", output && "output", input && "input"].filter(Boolean);
      const activeTab = toolTab && availableTabs.includes(toolTab) ? toolTab : availableTabs[0] || null;

      return (
        <>
          <CollapseComponent variant="row"
            label={message.update.title || message.update.name || message.update.kind || message.update.toolCallId}
            icon={getKindIcon(message.update.kind, message.update.status)}
            badge={typeof message.update._meta?.executionTime === "string" ? `${message.update._meta.executionTime}s` : undefined}
          >
            {activeTab && (
              <Tabs className="acp-tool-tabs" variant="pills" keepMounted={false} value={activeTab} onChange={setToolTab}>
                <Tabs.List>
                  {hasContent && <Tabs.Tab value="content">Content</Tabs.Tab>}
                  {input && <Tabs.Tab value="input">Input</Tabs.Tab>}
                  {output && <Tabs.Tab value="output">Output</Tabs.Tab>}
                </Tabs.List>
                {hasContent && <Tabs.Panel value="content">{toolContent?.map(renderToolCallContent)}</Tabs.Panel>}
                {[["input", input], ["output", output]].map(([value, data]) => data && (
                  <Tabs.Panel key={value} value={value!} className="selectable">
                    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHilight]} urlTransform={urlTransform}>{data}</Markdown>
                  </Tabs.Panel>
                ))}
              </Tabs>
            )}
          </CollapseComponent>
          {permissionRequest && (
            <Group grow gap={4} my={4}>
              {permissionRequest.options.map(option => {
                const { color, font } = getPermissionIcon(option.kind);

                return (
                  <Button key={option.optionId} variant="light" color={color} size="xs" title={option.name} leftSection={<i>{font}</i>}
                    onClick={() => onAcpPermissionChoice(permissionRequest!.requestId, option.optionId)}
                  >
                    {option.name}
                  </Button>
                );
              })}
            </Group>
          )}
          {elicitationRequest && <ElicitationComponent request={elicitationRequest} />}
        </>
      );
  }

  return null;
});

export const MessageComponent = React.memo(({ messages, sessionId }: { messages: AcpSDK.SessionNotification[]; sessionId: string; }) => {
  type Entry = { message: AcpSDK.SessionNotification; index: number };
  type Group = { entries: Entry[]; toolCount: number; failedCount: number };
  const groups: Group[] = [];
  let pendingThoughts: Entry[] = [];

  function flushThoughts() {
    for (const thought of pendingThoughts) groups.push({ entries: [thought], toolCount: 0, failedCount: 0 });
    pendingThoughts = [];
  }

  messages.forEach((message, index) => {
    if (message.sessionId !== sessionId) return;

    const entry = { message, index };
    const update = message.update;
    const last = groups.at(-1);
    if (update.sessionUpdate === "agent_thought_chunk" && last?.toolCount) {
      pendingThoughts.push(entry);
      return;
    }

    const canGroup = (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      && (update.status === "completed" || update.status === "failed")
      && !update._meta?.permissionRequest && !update._meta?.elicitationRequest;
    if (canGroup && last?.toolCount) {
      last.entries.push(...pendingThoughts, entry);
      last.toolCount++;
      if (update.status === "failed") last.failedCount++;
      pendingThoughts = [];
    } else {
      flushThoughts();
      groups.push({ entries: [entry], toolCount: canGroup ? 1 : 0, failedCount: canGroup && update.status === "failed" ? 1 : 0 });
    }
  });
  flushThoughts();

  function renderMessage({ message, index }: Entry) {
    return (
      <Stack key={index} gap={0} px={2} py={4} className="animate fade-in acp-message" data-kind={message.update.sessionUpdate}>
        <MessageMemo message={message} />
      </Stack>
    );
  }

  return groups.map(group => group.toolCount > 1 ? (
    <Stack key={group.entries[0].index} gap={0} px={2} className="acp-message">
      <CollapseComponent variant="row" label={`${group.toolCount} tool calls · ${group.failedCount ? `${group.failedCount} failed` : "Completed"}`}
        icon={<Box component="i" c={group.failedCount ? "red" : undefined}>{kindIcons.other}</Box>}>
        {group.entries.map(renderMessage)}
      </CollapseComponent>
    </Stack>
  ) : renderMessage(group.entries[0]));
});
