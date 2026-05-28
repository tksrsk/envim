import React, { useEffect, useState, useRef, MouseEvent, ChangeEvent, KeyboardEvent } from "react";
import { PlanEntry, SessionNotification, SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { zMcpServer } from "@agentclientprotocol/sdk/dist/schema/zod.gen";

import { IAcpRegistry, IAcpRegistryAgent, IAcpStatus, IAcpSession } from "common/interface";

import { Emit } from "../../utils/emit";
import { Setting } from "../../utils/setting";
import { icons } from "../../utils/icons";

import { FlexComponent } from "../flex";
import { IconComponent } from "../icon";
import { MenuComponent } from "../menu";
import { CollapseComponent } from "../collapse";
import { MessageComponent } from "./message";

interface State {
  visible: boolean;
  status: IAcpStatus;
  sessions: IAcpSession[];
  messages: SessionNotification[];
  input: string;
  mode: { main: "normal" | "input" | "blur", sub: "package" | "prompt" | "mcp", mcp?: number };
  session: IAcpSession | null;
  scroll: boolean;
  files: string[];
  registry: IAcpRegistry;
}

const styles: { [k: string]: React.CSSProperties } = {
  command: {
    position: "absolute",
    width: 0,
    height: 0,
    padding: 0,
  },
  panel: {
    width: 400,
    fontSize: "9px",
  },
};

export function AcpComponent() {
  const [state, setState] = useState<State>({
    visible: false,
    status: { status: "disconnected" },
    sessions: [],
    messages: [],
    input: JSON.stringify({name: "", package: { command: [] }}, null, 2),
    mode: { main: "input", sub: "package" },
    session: null,
    scroll: false,
    files: [],
    registry: { npx: { available: false, agent: [] }, uvx: { available: false, agent: [] } },
  });

  const scroll = useRef<HTMLDivElement>(null);
  const command = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const color = { input: "default", normal: "green", blur: "default" }[state.mode.main];

  useEffect(() => {
    Emit.on("acp:toggle", onAgentToggle);
    Emit.on("acp:status-changed", onStatusChanged);
    Emit.on("acp:session-update", onAcpSessionUpdate);
    Emit.on("acp:message-added", onMessageAdded);
    Emit.on("acp:file-add", onFileAdd);
    Emit.on("envim:focused", onFocused);

    return () => {
      Emit.off("acp:toggle", onAgentToggle);
      Emit.off("acp:status-changed", onStatusChanged);
      Emit.off("acp:session-update", onAcpSessionUpdate);
      Emit.off("acp:message-added", onMessageAdded);
      Emit.off("acp:file-add", onFileAdd);
      Emit.off("envim:focused", onFocused);
    };
  }, []);


  useEffect(() => {
    state.messages.length && !state.scroll && scrollTo("bottom");
  }, [state.messages]);

  useEffect(() => {
    setState(state => ({ ...state, mode: { ...state.mode, sub: checkAcpStatus("connected") ? "prompt" : "package" } }));
  }, [state.status.status]);

  useEffect(() => {
    const input = (() => {
      switch (state.mode.sub) {
        case "package": return JSON.stringify({name: "", package: { command: [] }}, null, 2);
        case "mcp": return JSON.stringify(state.mode.mcp ? Setting.acp.mcpServers[state.mode.mcp].server : {}, null, 2);
        case "prompt": return "";
        default: return "";
      }
    })();

    state.mode.mcp && Emit.send("envim:setting", Setting.get());
    setState(state => ({ ...state, input }));
  }, [state.mode.sub, state.mode.mcp]);

  useEffect(() => {
    if (state.mode.main === "blur") return;

    state.mode.main === "normal" ? command.current?.focus() : textarea.current?.focus();
  }, [state.mode.main]);

  function onAgentToggle(registry: IAcpRegistry) {
    setState(state => {
      !state.visible && state.status.status !== "disconnected" && scrollTo("bottom");
      return { ...state, visible: !state.visible, mode: { ...state.mode, main: state.visible ? "blur" : "normal" }, registry };
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
        (prev.update.sessionUpdate === "user_message_chunk" && curr.update.sessionUpdate === "user_message_chunk") ||
        (prev.update.sessionUpdate === "agent_message_chunk" && curr.update.sessionUpdate === "agent_message_chunk") ||
        (prev.update.sessionUpdate === "agent_thought_chunk" && curr.update.sessionUpdate === "agent_thought_chunk")
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

  function scrollTo(direction: "top" | "bottom" | "up" | "down" | "pageup" | "pagedown") {
    if (!scroll.current?.parentElement) return;
    switch (direction) {
      case "pagedown": return scroll.current.parentElement.scrollBy({ top: scroll.current.parentElement.clientHeight, behavior: "smooth" });
      case "pageup": return scroll.current.parentElement.scrollBy({ top: -scroll.current.parentElement.clientHeight, behavior: "smooth" });
      case "top": return scroll.current.parentElement.scrollTo({ top: 0, behavior: "smooth" });
      case "bottom": return scroll.current.scrollIntoView({ behavior: "smooth" });
      case "up": return scroll.current.parentElement.scrollBy({ top: -50, behavior: "smooth" });
      case "down": return scroll.current.parentElement.scrollBy({ top: 50, behavior: "smooth" });
    }
  }

  function handleScrollContainer(e: React.UIEvent) {
    const el = e.currentTarget;
    setState(state => ({ ...state, scroll: el.scrollHeight - el.scrollTop - el.clientHeight > 5 }));
  }

  function handleSelectPackage(provider: string, agent: IAcpRegistryAgent) {
    if (provider === "custom") {
      setState(state => ({ ...state, mode: { main: "input", sub: "package" }, input: JSON.stringify(agent, null, 2) }));
    } else {
      handleStartAgent(agent);
    }
  }

  function handleDeleteCustomPackage(e: MouseEvent, agent: IAcpRegistryAgent) {
    e.stopPropagation();

    Setting.acp = { ...Setting.acp, customs: (Setting.acp.customs || []).filter(custom => custom.name !== agent.name) };
    Emit.send("envim:setting", Setting.get());
  }

  function handleStartAgent(agent: IAcpRegistryAgent) {
    Emit.send("acp:start-agent", agent);
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

  function handleSetSessionConfigOption(configId: string, value: string | boolean) {
    checkAcpStatus("processing") || Emit.send("acp:config-session", configId, value);
  }

  function handleSelectCommand(selected: string) {
    setState(state => ({ ...state, input: `${state.input}/${selected} ` }));
  }

  function renderFile(file: string) {
    const icon = icons.find(icon => file.match(icon.match))!;

    return <IconComponent font={icon.font} color={`${icon.color}-fg`} text={file} onClick={() => Emit.send("envim:command", `edit ${file}`)} />;
  }

  function handleRemoveFile(file: string) {
    setState(state => ({
      ...state,
      files: state.files.filter(f => f !== file)
    }));
  }

  function handleEditMcp(e: MouseEvent | ChangeEvent, action: "toggle" | "delete", index: number) {
    e.stopPropagation();

    switch (action) {
      case "toggle":
        Setting.acp.mcpServers[index].enabled = !Setting.acp.mcpServers[index].enabled;
        break;
      case "delete":
        Setting.acp.mcpServers.splice(index, 1);
        break;
    }

    setState(state => ({ ...state, mode: { main: "input", sub: checkAcpStatus("connected") ? "prompt" : "package" } }));
    Emit.send("envim:setting", Setting.get());
  }

  function getPlaceholder() {
    switch (state.mode.sub) {
      case "package": return "Select or Type an ACP package";
      case "mcp": return "Enter mcp server settings as JSON";
      case "prompt": return "Type your message";
      default: return "";
    }
  }

  function handleConfirmInput() {
    const value = state.input.trim();

    switch (state.mode.sub) {
      case "package":
        try {
          const agent = JSON.parse(value);

          if (!agent) return;

          Setting.acp = { ...Setting.acp, customs: [...(Setting.acp.customs || []).filter(custom => custom.name !== agent?.name), agent] };
          Emit.send("envim:setting", Setting.get());
          handleStartAgent(agent);
        } finally {
          return;
        }
      case "mcp":
        try {
          const server = JSON.parse(value);

          if (!zMcpServer.safeParse(server).success) {
            return;
          }

          if (state.mode.mcp && Setting.acp.mcpServers[state.mode.mcp] ) {
            Setting.acp.mcpServers[state.mode.mcp].server = server;
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

    setState(state => ({ ...state, input: "", files: [], mode: { main: "normal", sub: checkAcpStatus("connected") ? "prompt" : "package" } }));
  }

  function handleCancelPrompt() {
    if (!checkAcpStatus("processing")) {
      return;
    }

    Emit.send("acp:cancel-prompt", state.status.sessionId);
  }

  function handleNormalKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();

    switch (e.key) {
      case "i": return setState(state => ({ ...state, mode: { ...state.mode, main: "input" } }));
      case "g": return scrollTo("top");
      case "G": return scrollTo("bottom");
      case "k": return scrollTo("up");
      case "j": return scrollTo("down");
      case "u": return e.ctrlKey && scrollTo("pageup");
      case "d": return e.ctrlKey && scrollTo("pagedown");
      case "q": return handleCancelPrompt();
      case "Enter": return handleConfirmInput();
    }
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setState(state => ({ ...state, mode: { ...state.mode, main: "normal" } }));
    }
  }

  function onFocused() {
    setState(state => {
      const main = (() => {
        switch (document.activeElement) {
          case command.current: return "normal";
          case textarea.current: return "input";
          default: return "blur";
        }
      })();
      return state.mode.main === main ? state : { ...state, mode: { ...state.mode, main } };
    });
  }

  function onCancel(e: MouseEvent) {
    e.stopPropagation();

    if (document.activeElement !== textarea.current && document.activeElement !== command.current) {
      state.mode.main === "input" ? textarea.current?.focus() : command.current?.focus();
    }
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

  function getPriorityColor (priority: PlanEntry["priority"]) {
    switch (priority) {
      case "high": return "red";
      case "medium": return "yellow";
      case "low": return "gray";
      default: return "gray";
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

  function renderRegistryProvider([kind, registry]: [string, IAcpRegistry[keyof IAcpRegistry]]) {
    return !registry.available || registry.agent.length === 0 ? null : (
      <MenuComponent key={kind} side label={kind}>
        {registry.agent.map((agent, i) => (
          <FlexComponent key={i} animate="hover" title={agent.description} onClick={() => handleSelectPackage(kind, agent)} spacing>
            {agent.name}
            {kind === "custom" && <IconComponent color="gray" font="" float="right" onClick={e => handleDeleteCustomPackage(e, agent)} hover />}
          </FlexComponent>
        ))}
      </MenuComponent>
    );
  }

  function renderConfigOption(config: SessionConfigOption) {
    switch (config.type) {
      case "boolean":
        return (
          <FlexComponent key={config.id} animate="hover" onClick={() => handleSetSessionConfigOption(config.id, !config.currentValue)} spacing>
            <input type="checkbox" checked={config.currentValue} readOnly />
            {config.name}
          </FlexComponent>
        );
      case "select":
        const renderConfigSelectOption = (option: SessionConfigSelectOption) => (
          <FlexComponent key={option.value} active={config.currentValue === option.value} title={option.description || ""} onClick={() => handleSetSessionConfigOption(config.id, option.value)} spacing>
            {option.name}
          </FlexComponent>
        );
        return (
          <MenuComponent key={config.id} label={config.name}>
            {config.options.map(option => "group" in option
              ? <MenuComponent key={option.group} label={option.name}>{option.options.map(renderConfigSelectOption)}</MenuComponent>
              : renderConfigSelectOption(option))
            }
          </MenuComponent>
        );
      default:
        return null;
    }
  }

  return state.visible === false ? null : (
    <FlexComponent color="default" overflow="visible" direction="column" position="absolute" padding={[8]} inset={[0, 0, 0, "auto"]} style={styles.panel} onMouseDown={onCancel} onMouseUp={onCancel}>
      <input style={styles.command} type="text" ref={command} onKeyDown={handleNormalKeyDown} onFocus={() => Emit.share("envim:focused")} tabIndex={-1} />
      <FlexComponent color={color} grow={1} shrink={1} direction="column" border={[1]} rounded={[2]} shadow>
        {state.status.sessionId ? (
          <FlexComponent color="default" direction="column" grow={1} shrink={1} overflow="auto" padding={[4]} onScroll={handleScrollContainer}>
            <MessageComponent messages={state.messages} sessionId={state.status.sessionId} />

            <div ref={scroll} />
          </FlexComponent>
        ) : (
          <FlexComponent color="default" horizontal="center" vertical="center" grow={1}>
            <span style={{ opacity: 0.5 }}>No active session</span>
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
        {state.session?.plan && state.session.plan.length > 0 && (
          <CollapseComponent
            label=" Plans"
            badge={`${state.session.plan.filter(({ status }) => ["completed", "failed"].includes(status)).length} / ${state.session.plan.length}`}
            style={{marginBottom: 4}}
            open
          >
              {state.session.plan.map((entry, index) => (
                <FlexComponent key={index} vertical="center" color={getPriorityColor(entry.priority)} margin={[1]} padding={[2]} rounded={[2]}>
                  {getStatusIcon(entry.status)}
                  <FlexComponent grow={1} shrink={1} whiteSpace="pre-wrap" spacing>{entry.content}</FlexComponent>
                </FlexComponent>
              ))}
          </CollapseComponent>
        )}
        {state.files.length > 0 && (
          <CollapseComponent
            label=" Files"
            badge={`${state.files.length}`}
            style={{marginBottom: 4}}
            open
          >
              {state.files.map(file => (
                <FlexComponent key={file}>
                  {renderFile(file)}
                  <div className="space" />
                  <IconComponent font="" color="gray-fg" float="right" onClick={() => handleRemoveFile(file)} />
                </FlexComponent>
              ))}
          </CollapseComponent>
        ) }
        <FlexComponent overflow="visible">
          {checkAcpStatus("connected") && <IconComponent font="" color="red-fg" onClick={handleStopAgent} />}
          {checkAcpStatus("connected") && <IconComponent font="󰍩" color="lightblue-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "prompt" } }))} />}
          {!checkAcpStatus("connected") && (
            <MenuComponent label={() => <IconComponent font="" color="green-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "package" } }))} />}>
              {Object.entries({ ...state.registry, custom: { available: true, agent: Setting.acp.customs } }).map(renderRegistryProvider)}
            </MenuComponent>
          )}
          <MenuComponent label={() => <IconComponent font="" color="purple-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "mcp" } }))} />}>
            {Setting.acp.mcpServers.map((mcp, i) => (
              <FlexComponent key={i} animate="hover" onClick={() => setState(state => ({ ...state, mode: { main: "normal", sub: "mcp", mcp: i } }))} spacing>
                <input type="checkbox" checked={mcp.enabled} onChange={e => handleEditMcp(e, "toggle", i)} />
                {mcp.server.name}
                <IconComponent color="gray" font="" float="right" onClick={e => handleEditMcp(e, "delete", i)} hover />
              </FlexComponent>
            ))}
          </MenuComponent>
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
          ref={textarea}
          placeholder={getPlaceholder()}
          value={state.input}
          onChange={e => setState(state => ({ ...state, input: e.target.value }))}
          onKeyDown={handleInputKeyDown}
          onFocus={() => Emit.share("envim:focused")}
          rows={8}
        />
        <FlexComponent overflow="visible" vertical="center" padding={[4, 0, 0]}>
          {state.session && state.session.commands.length > 0 && (
            <MenuComponent label="" color="green-fg">
              {state.session.commands.map((command) => (
                <FlexComponent key={command.name} onClick={() => handleSelectCommand(command.name)} title={command.description} spacing>
                  /{command.name}
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          {state.session?.configOptions?.map(renderConfigOption)}
          <div className="space" />
          {checkAcpStatus("processing") && <div className="animate loading inline" />}
          <IconComponent font="" color="red-fg" onClick={handleCancelPrompt} style={getDisabledStyle(state.mode.sub !== "prompt" || !checkAcpStatus("processing"))} />
          <IconComponent font="󰒊" color="blue-fg" onClick={handleConfirmInput} style={getDisabledStyle(state.mode.sub === "prompt" && (!state.status.sessionId || checkAcpStatus("processing")))} />
        </FlexComponent>
      </FlexComponent>
    </FlexComponent>
  );
}
