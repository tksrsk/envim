import React from "react";
import { Alert, Badge, Box, Button, Group, Loader, Paper, Stack, Tabs, Text } from "@mantine/core";
import * as AcpSDK from "@agentclientprotocol/sdk/unstable";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHilight from "rehype-highlight";
import { diffLines } from "diff";

import { IPermissionRequest, IElicitationRequest, IAcpSession, IAcpTerminalOutput } from "common/interface";

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

const MessageMemo = React.memo(({ message, sessions }: { message: AcpSDK.SessionNotification; sessions?: ReadonlyMap<string, IAcpSession> }) => {
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
      case "session":
        return <Box>Session {sessions?.get(content.sessionId)?.name ?? content.sessionId}</Box>;
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
    case "session_message": {
      const { senderSessionId, recipientSessionId, content } = message.update;
      const sender = senderSessionId && (sessions?.get(senderSessionId)?.name ?? senderSessionId);
      const recipient = recipientSessionId && (sessions?.get(recipientSessionId)?.name ?? recipientSessionId);
      return (
        <Stack gap={2}>
          <Box c="dimmed">{sender || "Unknown sender"} → {recipient || "Unknown recipient"}</Box>
          {content?.map((block, index) => <React.Fragment key={index}>{renderContent(block)}</React.Fragment>)}
        </Stack>
      );
    }
    case "notice":
      return <Alert title={message.update.title}>{message.update.description}</Alert>;
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
                {hasContent && <Tabs.Panel value="content">{toolContent?.map((content, index) => <React.Fragment key={index}>{renderToolCallContent(content)}</React.Fragment>)}</Tabs.Panel>}
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

export function AgentIcon({ icon }: { icon?: string | null }) {
  return icon ? <i className="agent-icon" style={{ maskImage: `url(${icon})` }} /> : <i>{"\uEC1E"}</i>;
}

function getStatusIcon(status?: string | null) {
  switch (status) {
    case "pending": return <Box component="i" c="dimmed">{uiIcons.pending}</Box>;
    case "in_progress": return <Loader size="1em" mx={4} />;
    case "completed": return <Box component="i" c="green">{uiIcons.success}</Box>;
    case "failed": return <Box component="i" c="red">{uiIcons.error}</Box>;
    default: return null;
  }
}

function getPriorityColor(priority: AcpSDK.PlanEntry["priority"]) {
  switch (priority) {
    case "high": return "red";
    case "medium": return "yellow";
    case "low": return "gray";
    default: return "gray";
  }
}

function renderPlanEntries(entries: AcpSDK.PlanEntry[]) {
  return entries.map((entry, index) => (
    <Group key={index} gap={6} wrap="nowrap" py={2}>
      {getStatusIcon(entry.status)}
      <Text size="xs" style={{ flex: 1, whiteSpace: "pre-wrap" }} td={entry.status === "completed" ? "line-through" : undefined} c={entry.status === "completed" ? "dimmed" : undefined}>{entry.content}</Text>
      <Badge size="xs" variant="dot" color={getPriorityColor(entry.priority)}>{entry.priority}</Badge>
    </Group>
  ));
}

export function SessionPlans({ session }: { session: IAcpSession }) {
  const plans = session.plans ?? [];
  if (!session.plan.length && !plans.length) return null;

  const entries = [...session.plan, ...plans.flatMap(plan => plan.type === "items" ? plan.entries : [])];
  const completed = entries.filter(entry => ["completed", "failed"].includes(entry.status)).length;

  return (
    <CollapseComponent label={session.subagent ? "Plans" : "Session plans"} icon={<i></i>} badge={entries.length ? `${completed} / ${entries.length}` : undefined} open>
      {renderPlanEntries(session.plan)}
      {plans.map(plan => (
        <Box key={plan.planId}>
          {plan.type === "items" ? renderPlanEntries(plan.entries) : (
            <div className="selectable"><Markdown remarkPlugins={[remarkGfm]}>{plan.content}</Markdown></div>
          )}
        </Box>
      ))}
    </CollapseComponent>
  );
}

function SubagentMessage({ session, messages, sessions, open }: Pick<MessageProps, "messages" | "sessions"> & { session: IAcpSession; open: boolean }) {
  const { emit } = useWorkspace();
  const child = session.subagent!;
  const workState = child.state?.state;
  const stopReason = workState === "idle" && child.state && "stopReason" in child.state ? child.state.stopReason : undefined;
  const [label, color, icon] = workState === "running" ? ["Running", "dimmed", getStatusIcon("in_progress")]
    : workState === "requires_action" ? ["Awaiting action", "yellow", <Box component="i" c="yellow">{uiIcons.pending}</Box>]
    : workState === "idle" && stopReason === "error" ? ["Failed", "red", getStatusIcon("failed")]
    : workState === "idle" && stopReason === "cancelled" ? ["Cancelled", "dimmed", <i>{uiIcons.stop}</i>]
    : workState === "idle" && stopReason === "end_turn" ? ["Completed", "green", getStatusIcon("completed")]
    : workState === "idle" ? ["Idle", "dimmed", null]
    : [null, "dimmed", null];
  return (
    <CollapseComponent variant="row" label={session.name} icon={<AgentIcon />} open={open}
      badge={label ? () => <Group gap={4} wrap="nowrap" c={color}>{icon}<Text size="xs" c={color}>{label}</Text></Group> : undefined}
    >
      <Stack gap={4} pl="xs">
        {child.description && <Text size="xs">{child.description}</Text>}
        {child.capabilities?.cancel && (
          <Button size="compact-xs" variant="subtle" color="red" onClick={() => emit.send("acp:prompt:cancel", session.id)}>
            Cancel work
          </Button>
        )}
        <SessionPlans session={session} />
        <MessageComponent messages={messages} sessionId={session.id} sessions={sessions} />
      </Stack>
    </CollapseComponent>
  );
}

interface MessageProps {
  messages: AcpSDK.SessionNotification[];
  sessionId: string;
  sessions?: ReadonlyMap<string, IAcpSession>;
}

export const MessageComponent = React.memo(({ messages, sessionId, sessions }: MessageProps) => {
  type Entry = { message: AcpSDK.SessionNotification; index: number; subagent?: IAcpSession };
  type Group = { entries: Entry[]; toolCount: number; subagentCount: number; failedCount: number };
  const groups: Group[] = [];
  let pendingThoughts: Entry[] = [];

  function hasPendingRequest(update: AcpSDK.SessionUpdate) {
    return (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      && (update._meta?.permissionRequest || update._meta?.elicitationRequest);
  }

  function canGroupSubagent(session: IAcpSession): boolean {
    const workState = session.subagent?.state?.state;
    if (workState === "running" || workState === "requires_action") return false;
    if (messages.some(message => message.sessionId === session.id && hasPendingRequest(message.update))) return false;

    for (const child of sessions?.values() ?? []) {
      if (child.subagent?.parentId === session.id && !canGroupSubagent(child)) return false;
    }
    return true;
  }

  function flushThoughts() {
    for (const thought of pendingThoughts) groups.push({ entries: [thought], toolCount: 0, subagentCount: 0, failedCount: 0 });
    pendingThoughts = [];
  }

  messages.forEach((message, index) => {
    if (message.sessionId !== sessionId) return;

    const update = message.update;
    const subagent = update.sessionUpdate === "subagent_update" ? sessions?.get(update.sessionId) : undefined;
    if (update.sessionUpdate === "subagent_update" && !subagent?.subagent) return;
    const entry = { message, index, subagent };
    const last = groups.at(-1);
    const continuesGroup = last && (last.toolCount || last.subagentCount);
    if (update.sessionUpdate === "agent_thought_chunk" && continuesGroup) {
      pendingThoughts.push(entry);
      return;
    }

    const finishedTool = (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      && (update.status === "completed" || update.status === "failed")
      && !hasPendingRequest(update);
    const toolCount = finishedTool ? 1 : 0;
    const subagentCount = subagent && canGroupSubagent(subagent) ? 1 : 0;
    const workState = subagent?.subagent?.state;
    const failedSubagent = subagentCount && workState?.state === "idle" && "stopReason" in workState && workState.stopReason === "error";
    const failedCount = (finishedTool && update.status === "failed") || failedSubagent ? 1 : 0;

    if ((toolCount || subagentCount) && continuesGroup) {
      last.entries.push(...pendingThoughts, entry);
      last.toolCount += toolCount;
      last.subagentCount += subagentCount;
      last.failedCount += failedCount;
      pendingThoughts = [];
    } else {
      flushThoughts();
      groups.push({ entries: [entry], toolCount, subagentCount, failedCount });
    }
  });
  flushThoughts();

  function renderMessage({ message, index, subagent }: Entry, grouped = false) {
    return (
      <Stack key={index} gap={0} px={2} py={4} className="animate fade-in acp-message" data-kind={message.update.sessionUpdate}>
        {subagent
          ? <SubagentMessage session={subagent} messages={messages} sessions={sessions} open={!grouped} />
          : <MessageMemo message={message} sessions={sessions} />}
      </Stack>
    );
  }

  return groups.map(group => {
    if (group.toolCount + group.subagentCount < 2) return renderMessage(group.entries[0]);

    const counts = [
      group.toolCount && `${group.toolCount} tool call${group.toolCount === 1 ? "" : "s"}`,
      group.subagentCount && `${group.subagentCount} subagent${group.subagentCount === 1 ? "" : "s"}`
    ].filter(Boolean).join(", ");
    const unconfirmed = group.entries.some(({ subagent }) => subagent && subagent.subagent?.state?.state !== "idle");
    const outcome = group.failedCount ? `${group.failedCount} failed`
      : unconfirmed ? undefined : group.subagentCount ? "Finished" : "Completed";
    return (
      <Stack key={group.entries[0].index} gap={0} px={2} className="acp-message">
        <CollapseComponent variant="row" label={outcome ? `${counts} · ${outcome}` : counts}
          icon={<Box component="i" c={group.failedCount ? "red" : undefined}>{kindIcons.other}</Box>}>
          {group.entries.map(entry => renderMessage(entry, true))}
        </CollapseComponent>
      </Stack>
    );
  });
});
