import React from "react";
import * as AcpSDK from "@agentclientprotocol/sdk";

import { IAcpRegistry, IAcpRegistryAgent, IAcpStatus, IAcpSession } from "common/interface";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { MenuComponent } from "renderer/components/menu";
import { CollapseComponent } from "renderer/components/collapse";
import { MessageComponent } from "renderer/components/acp/message";
import { McpAppsComponent } from "renderer/components/acp/app";

interface State {
  visible: boolean;
  status: IAcpStatus;
  sessions: IAcpSession[];
  messages: AcpSDK.SessionNotification[];
  input: string;
  mode: { main: "normal" | "input" | "blur", sub: "package" | "prompt" | "mcp" | "search", mcp?: number };
  session: IAcpSession | null;
  scroll: boolean;
  files: string[];
  images: AcpSDK.ImageContent[];
  registry: IAcpRegistry;
  search: { query: string; highlight: boolean; active: number; ranges: Range[] };
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
  invisible: {
    display: "none",
  },
  image: {
    width: "90%",
  },
};

export function AcpComponent() {
  const [state, setState] = React.useState<State>({
    visible: false,
    status: { status: "disconnected" },
    sessions: [],
    messages: [],
    input: JSON.stringify({name: "", package: { command: [] }}, null, 2),
    search: { query: "", highlight: false, active: 0, ranges: [] },
    mode: { main: "input", sub: "package" },
    session: null,
    scroll: false,
    files: [],
    images: [],
    registry: { npx: { available: false, agent: [] }, uvx: { available: false, agent: [] } },
  });

  const scroll = React.useRef<HTMLDivElement>(null);
  const command = React.useRef<HTMLInputElement>(null);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const color = state.mode.main === "normal" ? "green" : { search: "orange" }[state.mode.sub] || "default";

  React.useEffect(() => {
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


  React.useEffect(() => {
    state.messages.length && !state.scroll && scrollTo("bottom");
  }, [state.messages]);

  React.useEffect(() => {
    setState(state => ({ ...state, mode: { ...state.mode, sub: checkAcpStatus("connected") ? "prompt" : "package" } }));
  }, [state.status.status]);

  React.useEffect(() => {
    const input = (() => {
      switch (state.mode.sub) {
        case "package": return JSON.stringify({name: "", package: { command: [] }}, null, 2);
        case "mcp": return JSON.stringify(typeof state.mode.mcp === "number" ? Setting.acp.mcpServers[state.mode.mcp].server : {}, null, 2);
        case "prompt": return "";
        default: return "";
      }
    })();

    typeof state.mode.mcp === "number" && Emit.send("envim:setting", Setting.get());
    setState(state => ({ ...state, input }));
  }, [state.mode.sub, state.mode.mcp]);

  React.useEffect(() => {
    if (state.mode.main === "blur") return;

    state.mode.main === "normal" ? command.current?.focus() : textarea.current?.focus();
  }, [state.mode.main]);

  React.useEffect(() => {
    const ranges: Range[] = [];

    if (state.search.query && scroll.current?.parentElement) {
      const regex = new RegExp(state.search.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const walker = document.createTreeWalker(scroll.current.parentElement, NodeFilter.SHOW_TEXT, {
        acceptNode: node => getComputedStyle(node.parentElement as HTMLElement).userSelect === "none"
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
      });
      let node: Text | null;

      while ((node = walker.nextNode() as Text | null)) {
        for (const match of node.data.matchAll(regex)) {
          const range = new Range();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
      }
    }

    setState(state => ({ ...state, search: { ...state.search, ranges } }));
  }, [state.search.query]);

  React.useEffect(() => {
    CSS.highlights.delete("search-all");
    CSS.highlights.delete("search-active");

    const range = state.search.ranges[state.search.active];

    if (!state.search.highlight || !range || !scroll.current?.parentElement) return;

    CSS.highlights.set("search-all", new Highlight(...state.search.ranges));
    CSS.highlights.set("search-active", new Highlight(range));

    const active = range.getBoundingClientRect();
    const base = scroll.current.parentElement.getBoundingClientRect();

    if (active.top < base.top || active.bottom > base.bottom) {
      scroll.current.parentElement.scrollBy({ top: active.top - base.top - base.height / 2 + active.height / 2, behavior: "smooth" });
    }
  }, [state.search]);

  function onAgentToggle(registry: IAcpRegistry) {
    setState(state => {
      !state.visible && state.status.status !== "disconnected" && scrollTo("bottom");
      return { ...state, visible: !state.visible, mode: { ...state.mode, main: state.visible ? "blur" : "normal" }, registry };
    });
  }

  function onStatusChanged(status: IAcpStatus) {
    setState(state => ({ ...state, status }));
  }

  function onMessageAdded(message: AcpSDK.SessionNotification) {
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

  function filterMessages(messages: AcpSDK.SessionNotification[], curr: AcpSDK.SessionNotification): AcpSDK.SessionNotification[] {
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

  function onScrollContainer(e: React.UIEvent) {
    const el = e.currentTarget;
    setState(state => ({ ...state, scroll: el.scrollHeight - el.scrollTop - el.clientHeight > 5 }));
  }

  function onSelectPackage(provider: string, agent: IAcpRegistryAgent) {
    if (provider === "custom") {
      setState(state => ({ ...state, mode: { main: "input", sub: "package" }, input: JSON.stringify(agent, null, 2) }));
    } else {
      onStartAgent(agent);
    }
  }

  function onDeleteCustomPackage(e: React.MouseEvent, agent: IAcpRegistryAgent) {
    e.stopPropagation();

    Setting.acp = { ...Setting.acp, customs: (Setting.acp.customs || []).filter(custom => custom.name !== agent.name) };
    Emit.send("envim:setting", Setting.get());
  }

  function onStartAgent(agent: IAcpRegistryAgent) {
    Emit.send("acp:start-agent", agent);
  }

  function onStopAgent() {
    Emit.send("acp:stop-agent");
  }

  function onLogout() {
    Emit.send("acp:logout");
  }

  function onCreateSession() {
    Emit.send("acp:create-session");
  }

  function onSwitchSession(sessionId: string) {
    if (checkAcpStatus("connected")) {
      Emit.send("acp:switch-session", sessionId);
    }
  }

  function onDeleteSession(sessionId: string) {
    Emit.send("acp:delete-session", sessionId);
  }

  function onSetSessionConfigOption(configId: string, value: string | boolean) {
    checkAcpStatus("processing") || Emit.send("acp:config-session", configId, value);
  }

  function onSelectCommand(selected: string) {
    setState(state => ({ ...state, input: `${state.input}/${selected} ` }));
  }

  function onRemoveFile(file: string) {
    setState(state => ({ ...state, files: state.files.filter(f => f !== file) }));
  }

  function onRemoveImage(index: number) {
    setState(state => ({ ...state, images: state.images.filter((_, i) => i !== index) }));
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap(item => item.getAsFile() || []);

    if (state.mode.sub !== "prompt" || !files.length) return;

    e.preventDefault();

    Promise.all(files.map(file => new Promise<AcpSDK.ImageContent>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve({
        data: String(reader.result).replace(/^data:[^,]+,/, ""),
        mimeType: file.type,
      });
      reader.readAsDataURL(file);
    }))).then(images => images.length && setState(state => ({ ...state, images: [...state.images, ...images] })));
  }

  function onEditMcp(e: React.MouseEvent | React.ChangeEvent, action: "toggle" | "delete", index: number) {
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
      case "search": return "Search messages...";
      default: return "";
    }
  }

  function onConfirmInput() {
    const { input, search } = state;

    switch (state.mode.sub) {
      case "package":
        try {
          const agent = JSON.parse(input);

          if (!agent) return;

          Setting.acp = { ...Setting.acp, customs: [...(Setting.acp.customs || []).filter(custom => custom.name !== agent?.name), agent] };
          Emit.send("envim:setting", Setting.get());
          onStartAgent(agent);
        } finally {
          return;
        }
      case "mcp":
        try {
          const server = JSON.parse(input);

          if (!server.name || !["http", "sse", "stdio", "acp"].includes(server.type)) {
            return;
          }

          if (typeof state.mode.mcp === "number" && Setting.acp.mcpServers[state.mode.mcp]) {
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

        Emit.send("acp:send-prompt", state.status.sessionId, input.trim(), state.files, state.images);

        break;
      case "search":
        search.query = input;
        search.highlight = true;
        search.active = 0;

        break;
    }

    setState(state => ({ ...state, search, input: "", files: [], images: [], mode: { main: "normal", sub: checkAcpStatus("connected") ? "prompt" : "package" } }));
  }

  function onCancelPrompt() {
    if (!checkAcpStatus("processing")) {
      return;
    }

    Emit.send("acp:cancel-prompt", state.status.sessionId);
  }

  function onNormalKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();

    switch (e.key) {
      case "i": return setState(state => ({ ...state, mode: { main: "input", sub: state.mode.sub === "search" ? "prompt" : state.mode.sub } }));
      case "g": return scrollTo("top");
      case "G": return scrollTo("bottom");
      case "k": return scrollTo("up");
      case "j": return scrollTo("down");
      case "u": return e.ctrlKey && scrollTo("pageup");
      case "d": return e.ctrlKey && scrollTo("pagedown");
      case "q": return onCancelPrompt();
      case "n": return state.search.query && onSearch(state.search.active + 1);
      case "N": return state.search.query && onSearch(state.search.active - 1);
      case "/": return onSearchInput();
      case "Enter": return onConfirmInput();
      case "Escape": return state.search.highlight && clearSearch();
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setState(state => ({ ...state, input: state.mode.sub === "search" ? "" : state.input, mode: { ...state.mode, main: "normal" } }));
    }
    if (e.key === "Enter" && state.mode.sub === "search") {
      onNormalKeyDown(e);
    }
  }

  function onSearchInput() {
    state.session && setState(state => ({ ...state, input: "", mode: { main: "input", sub: "search" }, search: { query: "", active: 0, highlight: false, ranges: [] } }));
  }

  function onSearch(active: number) {
    state.search.ranges.length && setState(s => ({ ...s, search: { ...s.search, highlight: true, active: (active + s.search.ranges.length) % s.search.ranges.length } }));
  }

  function clearSearch() {
    setState(s => ({ ...s, search: { ...s.search, highlight: false } }));
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

  function onCancel(e: React.MouseEvent) {
    e.stopPropagation();

    e.type !== "mousemove" && state.mode.main === "blur" && command.current?.focus();
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

  function getPriorityColor (priority: AcpSDK.PlanEntry["priority"]) {
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
          <FlexComponent key={i} animate="hover" title={agent.description} onClick={() => onSelectPackage(kind, agent)} spacing>
            {agent.name}
            {kind === "custom" && <IconComponent color="gray" font="" float="right" onClick={e => onDeleteCustomPackage(e, agent)} hover />}
          </FlexComponent>
        ))}
      </MenuComponent>
    );
  }

  function renderConfigOption(config: AcpSDK.SessionConfigOption) {
    switch (config.type) {
      case "boolean":
        return (
          <FlexComponent key={config.id} animate="hover" onClick={() => onSetSessionConfigOption(config.id, !config.currentValue)} spacing>
            <input type="checkbox" checked={config.currentValue} readOnly />
            {config.name}
          </FlexComponent>
        );
      case "select":
        const renderConfigSelectOption = (option: AcpSDK.SessionConfigSelectOption) => (
          <FlexComponent key={option.value} active={config.currentValue === option.value} title={option.description || ""} onClick={() => onSetSessionConfigOption(config.id, option.value)} spacing>
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

  return (
    <FlexComponent color="default" animate="fade-in" overflow="visible" direction="column" position="absolute" padding={[8]} inset={[0, 0, 0, "auto"]} style={state.visible ? styles.panel :styles.invisible} onMouseDown={onCancel} onMouseMove={onCancel} onMouseUp={onCancel}>
      <input style={styles.command} type="text" ref={command} onKeyDown={onNormalKeyDown} onFocus={() => Emit.share("envim:focused")} tabIndex={-1} />
      <FlexComponent color={color} grow={1} shrink={1} direction="column" border={[1]} rounded={[2]} shadow>
        {state.status.sessionId ? (
          <FlexComponent color="default" direction="column" grow={1} shrink={1} overflow="auto" padding={[4]} onScroll={onScrollContainer}>
            <MessageComponent messages={state.messages} sessionId={state.status.sessionId} />

            <div ref={scroll} />
          </FlexComponent>
        ) : state.status.status === "auth_required" && state.status.authMethods ? (
          <FlexComponent color="default" direction="column" grow={1} vertical="center" horizontal="center" padding={[16]}>
            <span style={{ marginBottom: 8 }}>Authentication Required</span>
            {state.status.authMethods.map(method => (
              <FlexComponent key={method.id} color="lightblue" padding={[8]} margin={[4]} rounded={[4]} shadow animate="hover"
                onClick={() => Emit.send("acp:authenticate", method.id)}
              >
                <IconComponent font="󰌆" text={method.name} />
              </FlexComponent>
            ))}
          </FlexComponent>
        ) : (
          <FlexComponent color="default" horizontal="center" vertical="center" grow={1}>
            <span style={{ opacity: 0.5 }}>No active session</span>
          </FlexComponent>
        )}
      </FlexComponent>

      <FlexComponent direction="column" overflow="visible" padding={[4]}>
        {state.status.error &&
          <FlexComponent color="red" padding={[4]} rounded={[4]}>
            <IconComponent font="" />
            {state.status.error}
          </FlexComponent>
        }
        {state.status.error && <div className="divider color-gray" /> }
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
          <CollapseComponent label=" Files" badge={`${state.files.length}`} style={{marginBottom: 4}} open>
              {state.files.map(file => (
                <FlexComponent key={file}>
                  <a href={`file://${file}`}>{file}</a>
                  <div className="space" />
                  <IconComponent font="" color="gray-fg" float="right" onClick={() => onRemoveFile(file)} />
                </FlexComponent>
              ))}
          </CollapseComponent>
        )}
        {state.status.sessionId && <McpAppsComponent sessionId={state.status.sessionId} />}
        {state.images.length > 0 && ( <CollapseComponent label=" Images" badge={`${state.images.length}`} style={{marginBottom: 4}} open>
            {state.images.map((image, index) => (
              <FlexComponent key={index} vertical="center" padding={[2]}>
                <img src={`data:${image.mimeType};base64,${image.data}`} style={styles.image} />
                <div className="space" />
                <IconComponent font="" color="gray-fg" onClick={() => onRemoveImage(index)} />
              </FlexComponent>
            ))}
          </CollapseComponent>
        )}
        <FlexComponent overflow="visible">
          {checkAcpStatus("connected") && <IconComponent font="" color="red-fg" onClick={onStopAgent} />}
          {checkAcpStatus("connected") && state.status.capabilities?.auth?.logout && <IconComponent font="󰍃" color="orange-fg" onClick={onLogout} />}
          {checkAcpStatus("connected") && <IconComponent font="󰍩" color="lightblue-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "prompt" } }))} />}
          {!checkAcpStatus("connected") && (
            <MenuComponent label={() => <IconComponent font="" color="green-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "package" } }))} />}>
              {Object.entries({ ...state.registry, custom: { available: true, agent: Setting.acp.customs } }).map(renderRegistryProvider)}
            </MenuComponent>
          )}
          <MenuComponent label={() => <IconComponent font="" color="purple-fg" onClick={() => setState(state => ({ ...state, mode: { main: "input", sub: "mcp" } }))} />}>
            {Setting.acp.mcpServers.map((mcp, i) => (
              <FlexComponent key={i} animate="hover" onClick={() => setState(state => ({ ...state, mode: { main: "normal", sub: "mcp", mcp: i } }))} spacing>
                <input type="checkbox" checked={mcp.enabled} onChange={e => onEditMcp(e, "toggle", i)} />
                {mcp.server.name}
                <IconComponent color="gray" font="" float="right" onClick={e => onEditMcp(e, "delete", i)} hover />
              </FlexComponent>
            ))}
          </MenuComponent>
          <div className="space" />
          {state.session && <IconComponent font="" color="orange-fg" text={state.search.ranges.length ? `${state.search.active + 1}/${state.search.ranges.length}` : ""} onClick={onSearchInput} />}
          {(checkAcpStatus("connected")) && (
            <MenuComponent label={() => <IconComponent color="lightblue-fg" font="" onClick={onCreateSession} />}>
              {state.sessions.filter(({ status }) => status === "show").map(session => (
                <FlexComponent key={session.id} animate="hover" active={state.status.sessionId === session.id} onClick={() => onSwitchSession(session.id)} spacing >
                  {session.name}
                  <IconComponent color="gray" font="󰅖" float="right" onClick={() => onDeleteSession(session.id) } hover />
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
          onKeyDown={onInputKeyDown}
          onPaste={onPaste}
          onFocus={() => Emit.share("envim:focused")}
          rows={8}
        />
        <FlexComponent overflow="visible" vertical="center" padding={[4, 0, 0]}>
          {state.session && state.session.commands.length > 0 && (
            <MenuComponent label="" color="green-fg">
              {state.session.commands.map((command) => (
                <FlexComponent key={command.name} onClick={() => onSelectCommand(command.name)} title={command.description} spacing>
                  /{command.name}
                </FlexComponent>
              ))}
            </MenuComponent>
          )}
          {state.session?.configOptions?.map(renderConfigOption)}
          <div className="space" />
          {checkAcpStatus("processing") && <div className="animate loading inline" />}
          <IconComponent font="" color="red-fg" onClick={onCancelPrompt} style={getDisabledStyle(state.mode.sub !== "prompt" || !checkAcpStatus("processing"))} />
          <IconComponent font="󰒊" color="blue-fg" onClick={onConfirmInput} style={getDisabledStyle(state.mode.sub === "prompt" && (!state.status.sessionId || checkAcpStatus("processing")))} />
        </FlexComponent>
      </FlexComponent>
    </FlexComponent>
  );
}
