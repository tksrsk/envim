import React, { useEffect, useState, useRef, MouseEvent, ChangeEvent, KeyboardEvent } from "react";
import { ContentBlock, ToolCallContent, PlanEntry, SessionNotification } from "@agentclientprotocol/sdk";
import { zMcpServer } from "@agentclientprotocol/sdk/dist/schema/zod.gen";

import { IPermissionRequest, IAcpStatus, IAcpSession  } from "common/interface";

import { Emit } from "../utils/emit";
import { Setting } from "../utils/setting";
import { icons } from "../utils/icons";

import { FlexComponent } from "./flex";
import { IconComponent } from "./icon";
import { MenuComponent } from "./menu";

interface State {
  visible: boolean;
  status: IAcpStatus;
  sessions: IAcpSession[];
  messages: SessionNotification[];
  input: string;
  mode: "command" | "prompt" | number;
  session: IAcpSession | null;
  scroll: boolean;
  files: string[];
}

const styles = {
  panel: {
    width: 400,
    fontSize: "9px",
  },
};

export function AcpComponent() {
  const [state, setState] = useState<State>({
    visible: false,
    status: { status: "disconnected", plan: [] },
    sessions: [],
    messages: [],
    input: Setting.acp.command,
    mode: "command",
    session: null,
    scroll: false,
    files: [],
  });

  const scroll = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => {
    Emit.on("acp:toggle", onAgentToggle);
    Emit.on("acp:status-changed", onStatusChanged);
    Emit.on("acp:session-update", onAcpSessionUpdate);
    Emit.on("acp:message-added", onMessageAdded);
    Emit.on("acp:file-add", onFileAdd);

    return () => {
      Emit.off("acp:toggle", onAgentToggle);
      Emit.off("acp:status-changed", onStatusChanged);
      Emit.off("acp:session-update", onAcpSessionUpdate);
      Emit.off("acp:message-added", onMessageAdded);
      Emit.off("acp:file-add", onFileAdd);
    };
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer.current);
        timer.current = +setTimeout(() => setState(state => ({ ...state, scroll: !entry.isIntersecting })), 200);
      },
      { threshold: 0.1 }
    );

    scroll.current && observer.observe(scroll.current);

    return () => observer.disconnect();
  }, [scroll.current]);

  useEffect(() => {
    state.messages.length && !state.scroll && scrollToBottom();
  }, [state.messages]);

  useEffect(() => {
    setState(state => ({ ...state, mode: checkAcpStatus("connected") ? "prompt" : "command" }));
  }, [state.status.status]);

  useEffect(() => {
    const input = (() => {
      switch (typeof state.mode === "number" ? "mcp" : state.mode) {
        case "command": return Setting.acp.command;
        case "mcp": return JSON.stringify(Setting.acp.mcpServers[state.mode]?.server || {}, null, 2);
        case "prompt": return "";
      }
    })();

    Emit.send("envim:setting", Setting.get());
    setState(state => ({ ...state, input }));
  }, [state.mode]);

  function onAgentToggle() {
    setState(state => {
      !state.visible && (state.status.status === "disconnected" ? handleStartAgent() : scrollToBottom());
      return { ...state, visible: !state.visible };
    });
  }

  function onStatusChanged(status: IAcpStatus) {
    setState(state => ({ ...state, status }));
  }

  function onMessageAdded(message: SessionNotification) {
    setState(state => ({
      ...state,
      messages: filterMessages(state.messages, message)
    }));
  }

  function onAcpSessionUpdate(sessionId: string, sessions: IAcpSession[]) {
    setState(state => {
      const session = sessions.find(s => s.id === sessionId) || null;
      const deletedSessionIds = state.sessions.map(s => s.id).filter(id => !sessions.some(ns => ns.id === id));
      const messages = deletedSessionIds.length > 0
        ? state.messages.filter(message => !deletedSessionIds.includes(message.sessionId))
        : state.messages;

      return { ...state, sessions, session, messages };
    });
  }

  function onFileAdd(file: string) {
    setState(state => ({
      ...state,
      files: [ ...state.files.filter(f => f !== file), file ]
    }));
  }

  function filterMessages(messages: SessionNotification[], curr: SessionNotification): SessionNotification[] {
    const prev = messages.pop();

    if (
      prev && prev.sessionId === curr.sessionId && (
        (prev.update.sessionUpdate === "user_message_chunk" &&  curr.update.sessionUpdate === "user_message_chunk") ||
        (prev.update.sessionUpdate === "agent_message_chunk" &&  curr.update.sessionUpdate === "agent_message_chunk") ||
        (prev.update.sessionUpdate === "agent_thought_chunk" &&  curr.update.sessionUpdate === "agent_thought_chunk")
      ) && prev.update.content.type === "text" && curr.update.content.type === "text"
    ) {
      curr.update.content.text = `${prev.update.content.text}${curr.update.content.text}`;
    } else if (prev) {
      messages.push(prev);

      if (curr.update.sessionUpdate === "tool_call" || curr.update.sessionUpdate === "tool_call_update") {
        const toolCallId = curr.update.toolCallId;
        messages = messages.filter(msg => !(msg.update.sessionUpdate === "tool_call" || msg.update.sessionUpdate === "tool_call_update") || msg.update.toolCallId !== toolCallId);
      }
    }

    return [...messages, curr];
  }

  function scrollToBottom() {
    scroll.current?.scrollIntoView({ behavior: "smooth" });
    setState(state => ({ ...state, scroll: false }));
  }

  function handleStartAgent() {
    Emit.send("acp:start-agent");
  }

  function handleStopAgent() {
    Emit.send("acp:stop-agent");
  }

  function handleCreateSession() {
    Emit.send("acp:create-session");
  }

  function handleSwitchSession(sessionId: string) {
    if (checkAcpStatus("connected")) {
      Emit.send("acp:switch-session", sessionId);
    }
  }

  function handleDeleteSession(sessionId: string) {
    Emit.send("acp:delete-session", sessionId);
  }

  function handleSetSessionMode(mode: string) {
    checkAcpStatus("processing") || Emit.send("acp:set-session-mode", mode);
  }

  function handleSetSessionModel(modelId: string) {
    checkAcpStatus("processing") || Emit.send("acp:set-session-model", modelId);
  }

  function handleSelectCommand(selected: string) {
    setState(state => ({ ...state, input: `${state.input}/${selected} ` }));
  }

  function getIcon(file: string) {
    const icon = icons.find(icon => file.match(icon.match))!;

    return <IconComponent font={icon.font} color={`${icon.color}-fg`} text={file} />;
  }

  function handleRemoveFile(file: string) {
    setState(state => ({
      ...state,
      files: state.files.filter(f => f !== file)
    }));
  }

  function handleEditMcp(e: MouseEvent | ChangeEvent, mode: "toggle" | "delete", index: number) {
    e.stopPropagation();

    switch (mode) {
      case "toggle":
        Setting.acp.mcpServers[index].enabled = !Setting.acp.mcpServers[index].enabled;
        break;
      case "delete":
        Setting.acp.mcpServers.splice(index, 1);
        break;
    }

    setState(state => ({ ...state, mode: checkAcpStatus("connected") ? "prompt" : "command" }));
    Emit.send("envim:setting", Setting.get());
  }

  function getPlaceholder() {
    switch (typeof state.mode === "number" ? "mcp" : state.mode) {
      case "command": return "Type your acp command... (Shift+Enter to save)";
      case "mcp": return "Enter mcp server settings as JSON... (Shift+Enter to save)";
      case "prompt": return "Type your message... (Shift+Enter to send)";
    }
  }

  function handleConfirmInput() {
    const value = state.input.trim();
    const mode = checkAcpStatus("connected") ? "prompt" : "command";

    switch (typeof state.mode === "number" ? "mcp" : state.mode) {
      case "command":
        Setting.acp = { command: value, mcpServers: Setting.acp.mcpServers };

        Emit.send("envim:setting", Setting.get());
        handleStartAgent();

        break;
      case "mcp":
        try {
          const server = JSON.parse(value);

          if (!zMcpServer.safeParse(server).success) {
            return;
          }

          if (Setting.acp.mcpServers[state.mode]) {
            Setting.acp.mcpServers[state.mode].server = server;
          } else {
            Setting.acp.mcpServers.push({ enabled: true, server });
          }

          Emit.send("envim:setting", Setting.get());
        } catch {
          return;
        }

        break;
      case "prompt":
        if (checkAcpStatus("processing")) {
          return;
        }

        Emit.send("acp:send-prompt", state.status.sessionId, value, state.files);

        break;
    }

    setState(state => ({ ...state, input: "", files: [], mode }));
  }

  function handleCancelPrompt() {
    if (!checkAcpStatus("processing")) {
      return;
    }

    Emit.send("acp:cancel-prompt", state.status.sessionId);
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      handleConfirmInput();
    }
  }

  function getStatusIcon (status: PlanEntry["status"]) {
    switch (status) {
      case "pending": return <IconComponent color="gray-fg" font="󰐎" />;
      case "in_progress": return <IconComponent color="blue-fg" font="" />;
      case "completed": return <IconComponent color="green-fg" font="" />;
      default: return null;
    }
  }

  function getPriorityColor (priority: PlanEntry["priority"]) {
    switch (priority) {
      case "high": return "red";
      case "medium": return "yellow";
      case "low": return "gray";
      default: return "gray";
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

  function checkAcpStatus(type: "connected" | "processing"): boolean {
    const status = type === "connected"
      ? ["connected", "processing"]
      : ["connecting", "processing"];

    return status.includes(state.status.status);
  }

  function getDisabledStyle(disabled: boolean) {
    return {
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? "not-allowed" : "pointer"
    };
  }

  function renderToolContent(content: ToolCallContent) {
    switch (content.type) {
      case "content":
        return renderContent(content.content);
      case "diff":
        return (
          <details>
            <summary className="clickable"> [DIFF]</summary>
            <FlexComponent direction="column">
              <FlexComponent color="green" whiteSpace="pre-wrap">{content.newText}</FlexComponent>
              <FlexComponent color="red" whiteSpace="pre-wrap">{content.oldText}</FlexComponent>
            </FlexComponent>
          </details>
        );
      case "terminal":
        return `[terminal: ${content.terminalId}]`;
      default:
        return null;
    }
  }

  function renderContent(content: ContentBlock) {
    switch (content.type) {
      case "text":
        return <div className="selectable" style={{ whiteSpace: "pre-wrap" }}>{content.text}</div>;
      case "image":
        return <img src={content.uri || `data:${content.mimeType};base64,${content.data}`} />;
      case "resource":
        return <div style={{ whiteSpace: "pre-wrap" }}>[resource: {content.resource.uri}]</div>;
      case "resource_link":
        const icon = icons.find(icon => content.name.match(icon.match))!;
        return <IconComponent {...icon} text={content.name} />;
      default:
        return null;
    }
  }

  function renderMessage(message: SessionNotification) {
    switch (message.update.sessionUpdate) {
      case "user_message_chunk":
        return (
          <FlexComponent color="lightblue" margin={[2]} padding={[8]} rounded={[4]} shadow>
            {renderContent(message.update.content)}
          </FlexComponent>
        );
      case "agent_message_chunk":
        return renderContent(message.update.content);
      case "agent_thought_chunk":
        return (
          <details>
            <summary className="clickable">󰟶 Agent Thought...</summary>
            {renderContent(message.update.content)}
          </details>
        );
      case "tool_call":
      case "tool_call_update":
        const permissionRequest = message.update._meta?.permissionRequest as IPermissionRequest | undefined;

        return (
          <>
            <details>
              <summary className="clickable">
                <FlexComponent vertical="center">
                  {message.update.title || message.update.kind || message.update.toolCallId}
                  {typeof message.update._meta?.executionTime === "number" && `(${message.update._meta?.executionTime})s`}
                  <div className="space" />
                  {message.update.status === "in_progress" && <div className="animate loading inline" />}
                  {message.update.status === "completed" && <IconComponent font="" color="green-fg" />}
                  {message.update.status === "failed" && <IconComponent font="" color="red-fg" />}
                </FlexComponent>
              </summary>
              <FlexComponent direction="column">
                {message.update.content?.map(renderToolContent)}
              </FlexComponent>
            </details>
            {typeof message.update.rawInput === "string" && (
              <details>
                <summary className="clickable"> [INPUT]</summary>
                <FlexComponent whiteSpace="pre-wrap">{message.update.rawInput}</FlexComponent>
              </details>
            )}
            {typeof message.update.rawOutput === "string" && (
              <details>
                <summary className="clickable"> [OUTPUT]</summary>
                <FlexComponent whiteSpace="pre-wrap">{message.update.rawOutput}</FlexComponent>
              </details>
            )}
            {permissionRequest && !permissionRequest?.selectedOptionId && (
              <FlexComponent color="default" horizontal="center">
                <IconComponent font="" float="left" />
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
  }


  return state.visible === false ? null : (
    <FlexComponent color="default" overflow="visible" direction="column" position="absolute" padding={[8]} inset={[0, 0, 0, "auto"]} style={styles.panel} onMouseUp={e => e.stopPropagation()}>
      <FlexComponent grow={1} shrink={1} direction="column" spacing>
        {state.status.sessionId ? (
          <FlexComponent direction="column" grow={1} shrink={1} overflow="auto" padding={[4]}>
            {state.messages.map((message, i) => (message.sessionId !== state.status.sessionId ? null :
                <FlexComponent key={`message_${i}`} animate="fade-in" direction="column" margin={[4, 0]}>{renderMessage(message)}</FlexComponent>
            ))}

            <div ref={scroll} />
          </FlexComponent>
        ) : (
          <FlexComponent horizontal="center" vertical="center" grow={1}>
            <span style={{ opacity: 0.5 }}>No active session</span>
          </FlexComponent>
        )}
        {state.status.sessionId && state.scroll && (
          <FlexComponent position="absolute" inset={["auto", 8, 8, "auto"]} zIndex={1}>
            <IconComponent color="lightblue-fg" font="" onClick={scrollToBottom} />
          </FlexComponent>
        )}
      </FlexComponent>

      <FlexComponent direction="column" overflow="visible" padding={[4]}>
        {state.session?.usage &&
          <FlexComponent color="orange" padding={[4]} rounded={[4]}>
            <span>{state.session.usage.used.toLocaleString()} ({((state.session.usage.used / state.session.usage.size) * 100).toFixed(2)}%)</span>
            <div className="space" />
            {state.session.usage.cost && <span>{state.session.usage.cost.amount.toLocaleString()} {state.session.usage.cost.currency}</span>}
          </FlexComponent>
        }
        {state.session?.usage && <div className="divider color-gray" /> }
        {state.status.plan.map((entry, index) => (
          <FlexComponent key={index} vertical="center" color={getPriorityColor(entry.priority)} margin={[1]} padding={[2]} rounded={[2]}>
            {getStatusIcon(entry.status)}
            <FlexComponent grow={1} shrink={1} whiteSpace="pre-wrap" spacing>{entry.content}</FlexComponent>
          </FlexComponent>
        ))}
        {state.status.plan.length > 0 && <div className="divider color-gray" />}
        {state.files.map(file => (
          <FlexComponent key={file} margin={[2]} padding={[2]} animate="fade-in hover">
            {getIcon(file)}
            <IconComponent font="" color="gray" float="right" onClick={() => handleRemoveFile(file)} hover />
          </FlexComponent>
        ))}
        {state.files.length > 0 && <div className="divider color-gray" />}
        <FlexComponent overflow="visible" spacing>
          {(checkAcpStatus("connected")) && <IconComponent font="" color="red-fg" onClick={handleStopAgent} />}
          {(checkAcpStatus("connected")) && <IconComponent font="󰍩" color="lightblue-fg" onClick={() => setState(state => ({ ...state, mode: "prompt" }))} />}
          {!checkAcpStatus("connected") && <IconComponent font="" color="green-fg" onClick={() => setState(state => ({ ...state, mode: "command" }))} />}
          {Setting.acp.mcpServers.length > 0 && (
            <MenuComponent label={() => <IconComponent font="" color="purple-fg" onClick={() => setState(state => ({ ...state, mode: -1 })) } />}>
              {Setting.acp.mcpServers.map((mcp, i) => (
                <FlexComponent key={i} animate="hover" onClick={() => setState(state => ({ ...state, mode: i }))} spacing>
                  <input type="checkbox" checked={mcp.enabled} onChange={e => handleEditMcp(e, "toggle", i)} />
                  {mcp.server.name}
                  <IconComponent color="gray" font="" float="right" onClick={e => handleEditMcp(e, "delete", i)} hover />
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          <div className="space" />
          {(checkAcpStatus("connected")) && (
            <MenuComponent label={() => <IconComponent color="lightblue-fg" font="" onClick={handleCreateSession} />}>
              {state.sessions.filter(({ status }) => status === "show").map(session => (
                <FlexComponent key={session.id} animate="hover" active={state.status.sessionId === session.id} onClick={() => handleSwitchSession(session.id)} spacing >
                  {session.name}
                  <IconComponent color="gray" font="󰅖" float="right" onClick={() => handleDeleteSession(session.id) } hover />
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
        </FlexComponent>
        <textarea
          placeholder={getPlaceholder()}
          value={state.input}
          onChange={(e) => setState(state => ({ ...state, input: e.target.value }))}
          onKeyDown={handleInputKeyDown}
          rows={8}
        />
        <FlexComponent overflow="visible" vertical="center" padding={[4, 0, 0]}>
          {state.session && state.session.commands.length > 0 && (
            <MenuComponent label="" color="green-fg">
              {state.session.commands.map((command) => (
                <FlexComponent key={command.name} onClick={() => handleSelectCommand(command.name)} spacing>
                  {command.description}
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          {state.session?.modes?.availableModes && state.session.modes.availableModes.length > 0 && (
            <MenuComponent label="" color="yellow-fg">
              {state.session.modes.availableModes.map((mode) => (
                <FlexComponent key={mode.id} active={state.session!.modes!.currentModeId === mode.id} onClick={() => handleSetSessionMode(mode.id)} spacing>
                  {mode.name}
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          {state.session?.models?.availableModels && state.session.models.availableModels.length > 0 && (
            <MenuComponent label="󰆼" color="pink-fg">
              {state.session.models.availableModels.map((model) => (
                <FlexComponent key={model.modelId} active={state.session!.models!.currentModelId === model.modelId} onClick={() => handleSetSessionModel(model.modelId)} spacing>
                  {model.name}
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          <div className="space" />
          {checkAcpStatus("processing") && <div className="animate loading inline" />}
          <IconComponent font="" color="red-fg" onClick={handleCancelPrompt} style={getDisabledStyle(state.mode !== "prompt" || !checkAcpStatus("processing"))} />
          <IconComponent font="󰒊" color="blue-fg" onClick={handleConfirmInput} style={getDisabledStyle(state.mode === "prompt" && (!state.status.sessionId || checkAcpStatus("processing")))} />
        </FlexComponent>
      </FlexComponent>
    </FlexComponent>
  );
}
