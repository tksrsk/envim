import React from "react";
import { ActionIcon, Alert, Badge, Box, Button, CloseButton, Group, Loader, Menu, Paper, Popover, Progress, Stack, Text, Textarea, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import * as AcpSDK from "@agentclientprotocol/sdk/unstable";

import { ISetting, IAcpRegistry, IAcpRegistryAgent, IAcpStatus, IAcpSession } from "common/interface";
import { IFormRequest, schema } from "common/schema";

import { useWorkspace } from "renderer/context/workspace";
import { useFocus, FocusProvider } from "renderer/context/focus";

import { useApp } from "renderer/context/app";
import { uiIcons } from "renderer/utils/icons";

import { MenuComponent, SubMenuComponent, MenuItemComponent, TreeMenuItems, trackMenu } from "renderer/components/menu";
import { AgentIcon, MessageComponent, SessionPlans } from "renderer/components/acp/message";
import { McpAppsComponent } from "renderer/components/acp/app";
import { ElicitationComponent } from "renderer/components/acp/elicitation";

interface State {
  visible: boolean;
  status: IAcpStatus;
  notice?: AcpSDK.Notice;
  sessions: IAcpSession[];
  messages: AcpSDK.SessionNotification[];
  input: string;
  promptContext?: { label: string; value: string };
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
    border: 0,
    opacity: 0,
    outline: "none",
  },
  panel: {
    flex: "1 1 auto",
    minWidth: 0,
    fontSize: "var(--mantine-font-size-xs)",
  },
  invisible: {
    display: "none",
  },
};

type SettingItem = ISetting["acp"]["customs" | "mcpServers"][number];

export function AcpComponent() {
  const { setting: { acp }, updateSetting } = useApp();
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<State>({
    visible: false,
    status: { status: "disconnected" },
    sessions: [],
    messages: [],
    input: "",
    search: { query: "", highlight: false, active: 0, ranges: [] },
    session: null,
    scroll: false,
    files: [],
    images: [],
    registry: { npx: [], uvx: [], binary: [] },
  });

  const scroll = React.useRef<HTMLDivElement>(null);
  const command = React.useRef<HTMLInputElement>(null);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const { active } = useFocus();
  const main = active === command.current ? "normal" : active === textarea.current ? "input" : active === searchInput.current ? "search" : "blur";
  const color = { normal: "green", search: "orange" }[main as string] || "default";

  const [suggestion, setSuggestion] = React.useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = React.useState(false);
  const suggestionsId = React.useId();
  const commandPrefix = state.input.match(/^\/(\S*)$/)?.[1];
  const commandSuggestions = commandPrefix !== undefined && !state.promptContext && state.status.status !== "processing"
    ? (state.session?.commands ?? []).filter(command => command.name.toLowerCase().startsWith(commandPrefix.toLowerCase()))
    : [];
  const showCommandSuggestions = main === "input" && !suggestionsDismissed && commandSuggestions.length > 0;
  const selectedSuggestion = Math.min(suggestion, commandSuggestions.length - 1);

  React.useEffect(() => {
    emit.on("acp:file:add", onAcpFileAdd);
    emit.on("acp:prompt:context", onSetPromptContext);
    emit.on("acp:message:added", onAcpMessageAdded);
    emit.on("acp:session:update", onAcpSessionUpdate);
    emit.on("acp:notice:changed", onAcpNoticeChanged);
    emit.on("acp:status:changed", onAcpStatusChanged);
    emit.on("acp:toggle", onAcpToggle);
    emit.on("acp:setting:save", onAcpSettingSave);

    return () => {
      emit.off("acp:file:add", onAcpFileAdd);
      emit.off("acp:prompt:context", onSetPromptContext);
      emit.off("acp:message:added", onAcpMessageAdded);
      emit.off("acp:session:update", onAcpSessionUpdate);
      emit.off("acp:notice:changed", onAcpNoticeChanged);
      emit.off("acp:status:changed", onAcpStatusChanged);
      emit.off("acp:toggle", onAcpToggle);
      emit.off("acp:setting:save", onAcpSettingSave);
    };
  }, []);

  React.useEffect(() => {
    state.messages.length && !state.scroll && scrollTo("bottom");
  }, [state.messages]);

  React.useEffect(() => {
    state.visible && command.current?.focus();
  }, [state.visible]);

  React.useEffect(() => {
    CSS.highlights.delete("search-all");
    CSS.highlights.delete("search-active");

    const container = scroll.current?.parentElement;

    if (!state.search.highlight || !container) return;

    const ranges: Range[] = [];

    if (state.search.query) {
      const regex = new RegExp(state.search.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
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

    const active = ranges.length ? ((state.search.active % ranges.length) + ranges.length) % ranges.length : 0;
    const range = ranges[active];

    setState(state => ({ ...state, search: { ...state.search, ranges, active } }));

    if (range) {
      CSS.highlights.set("search-all", new Highlight(...ranges));
      CSS.highlights.set("search-active", new Highlight(range));

      const element = range.startContainer.parentElement as HTMLElement;
      const target = element.closest<HTMLElement>("p, pre, li, td, th, h1, h2, h3, h4, h5, h6") || element;

      target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      target.animate([{ backgroundColor: "var(--mantine-color-orange-light)" }, {}], { duration: 1200, easing: "ease-out" });
    }
  }, [state.search.query, state.search.active, state.search.highlight]);

  function onAcpFileAdd(file: string) {
    setState(state => ({
      ...state,
      files: [ ...state.files.filter(f => f !== file), file ]
    }));
  }

  function onSetPromptContext(context?: State["promptContext"]) {
    setState(state => ({ ...state, promptContext: context }));
  }

  function onAcpMessageAdded(message: AcpSDK.SessionNotification) {
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

  function onAcpNoticeChanged(notice?: AcpSDK.Notice) {
    setState(state => ({ ...state, notice }));
  }

  function onAcpStatusChanged(status: IAcpStatus) {
    setState(state => ({ ...state, status }));
  }

  function onAcpToggle(registry: IAcpRegistry) {
    setState(state => {
      !state.visible && state.status.status !== "disconnected" && scrollTo("bottom");
      return { ...state, visible: !state.visible, registry };
    });
  }

  function filterMessages(messages: AcpSDK.SessionNotification[], curr: AcpSDK.SessionNotification): AcpSDK.SessionNotification[] {
    const update = curr.update;

    if (update.sessionUpdate === "session_message" || update.sessionUpdate === "session_message_chunk") {
      const index = messages.findIndex(msg => msg.sessionId === curr.sessionId
        && msg.update.sessionUpdate === "session_message" && msg.update.messageId === update.messageId);
      const previous = messages[index]?.update;
      const base = previous?.sessionUpdate === "session_message" ? previous : undefined;
      let merged: AcpSDK.SessionMessage & { sessionUpdate: "session_message" };
      if (update.sessionUpdate === "session_message_chunk") {
        const content = [...(base?.content ?? [])];
        const last = content.at(-1);
        if (last?.type === "text" && update.content.type === "text") {
          content[content.length - 1] = { ...last, text: last.text + update.content.text };
        } else {
          content.push(update.content);
        }
        merged = { ...base, sessionUpdate: "session_message", messageId: update.messageId, content };
      } else {
        merged = { ...base, ...update };
      }
      const notification = { ...curr, update: merged };
      return index < 0 ? [...messages, notification] : messages.map((msg, i) => i === index ? notification : msg);
    }

    if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
      const index = messages.findIndex(msg => msg.sessionId === curr.sessionId && msg.update.sessionUpdate === "compaction_update" && msg.update.compactionId === update.compactionId);
      const previous = index < 0 ? undefined : messages[index].update as AcpSDK.CompactionUpdate & { sessionUpdate: "compaction_update" };
      const merged: AcpSDK.CompactionUpdate & { sessionUpdate: "compaction_update" } = update.sessionUpdate === "compaction_summary_chunk"
        ? { ...previous, sessionUpdate: "compaction_update", compactionId: update.compactionId, status: previous?.status || "in_progress", summary: [...(previous?.summary || []), update.content] }
        : { ...previous, ...update };
      const notification = { ...curr, update: merged };

      if (index < 0) return [...messages, notification];
      return messages.map((msg, i) => i === index ? notification : msg);
    }

    if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.messageId && update.content.type === "text") {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.sessionId !== curr.sessionId || (msg.update.sessionUpdate !== "agent_message_chunk" && msg.update.sessionUpdate !== "user_message_chunk" && msg.update.sessionUpdate !== "agent_thought_chunk") || msg.update.sessionUpdate !== update.sessionUpdate || msg.update.messageId !== update.messageId || msg.update.content.type !== "text") continue;
          update.content.text = `${msg.update.content.text}${update.content.text}`;
          messages[i] = curr;

          return [...messages];
      }
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const index = messages.findIndex(({ sessionId, update: previous }) =>
        sessionId === curr.sessionId && (previous.sessionUpdate === "tool_call" || previous.sessionUpdate === "tool_call_update") && previous.toolCallId === update.toolCallId
      );
      const previous = messages[index]?.update;
      if (previous?.sessionUpdate === "tool_call" || previous?.sessionUpdate === "tool_call_update") {
        const meta: Record<string, unknown> = { ...previous._meta };
        delete meta.permissionRequest;
        delete meta.elicitationRequest;

        const notification: AcpSDK.SessionNotification = {
          ...curr, update: { ...previous, ...update, sessionUpdate: "tool_call_update", _meta: { ...meta, ...update._meta } },
        };
        return messages.map((message, i) => i === index ? notification : message);
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
      openSettingForm("customs", acp.customs.findIndex(custom => custom === agent));
    } else {
      onAcpAgentStart(agent);
    }
  }

  function openSettingForm(key: "customs" | "mcpServers", index?: number, kind: "stdio" | "http" = "stdio") {
    const pairs = (title: string) => schema.array(title, schema.object({ name: schema.string("Name"), value: schema.string("Value") }, ["name", "value"]));
    const server = kind === "http"
      ? schema.object({ type: { const: "http" }, name: schema.string("Name"), url: schema.string("URL"), headers: pairs("Headers") }, ["name", "url"])
      : schema.object({
        name: schema.string("Name"), command: schema.string("Command"), args: schema.array("Arguments", schema.string("Argument")), env: pairs("Environment"),
      }, ["name", "command"]);
    const [title, form, name] = key === "customs"
      ? [`${uiIcons.agent} Custom agent`, schema.object({
        name: schema.string("Name"),
        package: schema.object({
          command: schema.array("Command", schema.string("Argument"), { description: "Executable followed by its arguments", default: [""] }),
          env: schema.record("Environment", schema.string("Value")),
        }),
      }, ["name"]), "Save & Start"]
      : [`${uiIcons.mcp} MCP server (${kind})`, schema.object({ enabled: schema.boolean("Enabled", true), server }), "Save"];

    emit.share("form:open", {
      title, schema: form, values: index === undefined ? undefined : acp[key][index],
      actions: [
        { action: "save", name, color: "green", font: uiIcons.save, submit: true },
        ...(index === undefined ? [] : [{ action: "delete", name: "Delete", color: "red", font: uiIcons.close }]),
      ],
      reply: { event: "acp:setting:save", via: "share", args: [key, index] },
    } satisfies IFormRequest);
  }

  function onAcpSettingSave(key: "customs" | "mcpServers", index: number | undefined, action?: string, item?: SettingItem) {
    if (action !== "delete" && (action !== "save" || !item)) return;

    const updated = updateSetting(setting => {
      const items: SettingItem[] = setting.acp[key];
      const next = items.toSpliced(index ?? items.length, index === undefined ? 0 : 1, ...(action === "save" && item ? [item] : []));
      return { ...setting, acp: { ...setting.acp, [key]: next } };
    });
    if (updated && action === "save" && key === "customs" && item && "package" in item) onAcpAgentStart(item);
  }

  function onAcpAuthenticate(method: AcpSDK.AuthMethod) {
    const { type, vars = [], link } = method as { type?: string; link?: string; vars?: { name: string; label?: string; secret?: boolean; optional?: boolean }[] };

    if (type !== "env_var") {
      emit.send("acp:auth:authenticate", method.id);
      return;
    }

    emit.share("form:open", {
      title: `󰌆 ${method.name}`, message: [method.description, link].filter(Boolean).join("\n"),
      schema: schema.object(
        Object.fromEntries(vars.map(({ name, label, secret }) => [name, schema.string(label || name, secret === false ? undefined : { format: "password" })])),
        vars.filter(({ optional }) => !optional).map(({ name }) => name),
      ),
      actions: [{ action: "authenticate", name: "Authenticate", color: "cyan", font: "󰌆", submit: true }],
      reply: { event: "acp:auth:authenticate", via: "send", args: [method.id] },
    } satisfies IFormRequest);
  }

  function onAcpAgentStart(agent: IAcpRegistryAgent) {
    emit.send("acp:agent:start", agent);
  }

  function onAcpAgentStop() {
    emit.send("acp:agent:stop");
  }

  function onAcpAuthLogout() {
    emit.send("acp:auth:logout");
  }

  function onAcpFollowToggle() {
    emit.send("acp:follow:toggle");
  }

  function onAcpSessionCreate() {
    emit.send("acp:session:create");
  }

  function onAcpSessionSwitch(sessionId: string) {
    if (checkAcpStatus("connected")) {
      emit.send("acp:session:switch", sessionId);
    }
  }

  function onAcpSessionDelete(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    emit.send("acp:session:delete", sessionId);
  }

  function onAcpSessionFork(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    checkAcpStatus("processing") || emit.send("acp:session:fork", sessionId);
  }

  function onAcpSessionConfig(configId: string, value: string | boolean) {
    checkAcpStatus("processing") || emit.send("acp:session:config", configId, value);
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

    if (!files.length) return;

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

  function onConfirmInput() {
    if (checkAcpStatus("processing")) return;

    const prompt = [state.promptContext?.value, state.input.trim()].filter(Boolean).join(" ");

    emit.send("acp:prompt:send", state.status.sessionId, prompt, state.files, state.images);
    setState(state => ({ ...state, input: "", files: [], images: [], promptContext: undefined }));
  }

  function onAcpPromptCancel() {
    if (!checkAcpStatus("processing")) {
      return;
    }

    emit.send("acp:prompt:cancel", state.status.sessionId);
  }

  function onNormalKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();

    switch (e.key) {
      case "i": return textarea.current?.focus();
      case "g": return scrollTo("top");
      case "G": return scrollTo("bottom");
      case "k": return scrollTo("up");
      case "j": return scrollTo("down");
      case "u": return e.ctrlKey && scrollTo("pageup");
      case "d": return e.ctrlKey && scrollTo("pagedown");
      case "q": return onAcpPromptCancel();
      case "n": return state.search.query && onSearch(state.search.active + 1);
      case "N": return state.search.query && onSearch(state.search.active - 1);
      case "/": return onSearchInput();
      case "Enter": return onConfirmInput();
      case "Escape": return state.search.highlight && clearSearch();
    }
  }

  function selectCommandSuggestion(name: string) {
    setState(state => ({ ...state, input: "", promptContext: { label: `/${name}`, value: `/${name}` } }));
    setSuggestion(0);
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;

    if (showCommandSuggestions && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setSuggestionsDismissed(true);
      } else if (e.key === "Enter") {
        selectCommandSuggestion(commandSuggestions[selectedSuggestion].name);
      } else {
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = (selectedSuggestion + step + commandSuggestions.length) % commandSuggestions.length;
        setSuggestion(next);
        document.getElementById(`${suggestionsId}-${next}`)?.scrollIntoView({ block: "nearest" });
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      command.current?.focus();
    }
  }

  function onSearchInput() {
    searchInput.current?.focus();
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || !["Enter", "Escape"].includes(e.key)) return;

    e.preventDefault();
    e.key === "Enter" && setState(state => ({ ...state, search: { ...state.search, highlight: true, active: 0 } }));
    command.current?.focus();
  }

  function onSearch(active: number) {
    setState(s => ({ ...s, search: { ...s.search, highlight: true, active } }));
  }

  function clearSearch() {
    setState(s => ({ ...s, search: { ...s.search, highlight: false } }));
  }

  const sessionsById = React.useMemo(() => new Map(state.sessions.map(session => [session.id, session])), [state.sessions]);

  function checkAcpStatus(type: "connected" | "processing"): boolean {
    const status = type === "connected"
      ? ["connected", "processing"]
      : ["connecting", "processing", "authenticating"];

    return status.includes(state.status.status);
  }

  function renderRegistryAgent({ kind, agent }: { kind: string; agent: IAcpRegistryAgent }, label: string) {
    return (
      <MenuItemComponent key={`${kind}/${agent.name}`} title={agent.description || undefined} onClick={() => onSelectPackage(kind, agent)}
        leftSection={<AgentIcon icon={agent.icon} />}
      >
        {label}
      </MenuItemComponent>
    );
  }

  function renderConfigOption(config: AcpSDK.SessionConfigOption) {
    switch (config.type) {
      case "boolean":
        return (
          <Button key={config.id} {...chipProps(config.currentValue)} title={config.name} leftSection={config.currentValue ? <i>{uiIcons.accept}</i> : undefined}
            onClick={() => onAcpSessionConfig(config.id, !config.currentValue)}
          >
            {config.name}
          </Button>
        );
      case "select":
        const renderConfigSelectOption = (option: AcpSDK.SessionConfigSelectOption) => (
          <MenuItemComponent key={option.value} active={config.currentValue === option.value} title={option.description || ""} onClick={() => onAcpSessionConfig(config.id, option.value)}>
            {option.name}
          </MenuItemComponent>
        );
        return (
          <MenuComponent key={config.id} label={() => <Button {...chipProps(false)} title={config.name} rightSection={<span style={{ opacity: .6 }}>▾</span>}>{getConfigValueName(config) || config.name}</Button>}>
            {config.options.map(option => "group" in option
              ? <SubMenuComponent key={option.group} label={option.name}>{option.options.map(renderConfigSelectOption)}</SubMenuComponent>
              : renderConfigSelectOption(option))
            }
          </MenuComponent>
        );
      default:
        return null;
    }
  }

  function chipProps(active: boolean) {
    return {
      variant: active ? "light" : "default",
      size: "compact-xs",
      fw: 400,
      style: { fontSize: "inherit", height: "var(--envim-control-size)", flexShrink: 0 },
    } as const;
  }

  function getConfigValueName(config: AcpSDK.SessionConfigOption) {
    if (config.type !== "select") return "";

    const options = config.options.flatMap(option => "group" in option ? option.options : [option]);

    return options.find(option => option.value === config.currentValue)?.name || "";
  }

  const connected = checkAcpStatus("connected");

  return (
    <FocusProvider targets={[command, textarea, searchInput]}>
      <Stack className="acp-panel" gap={8} p={8} bg="var(--mantine-color-body)" style={state.visible ? styles.panel : styles.invisible}>
        <input style={styles.command} type="text" ref={command} onKeyDown={onNormalKeyDown} tabIndex={-1} />

        <Group gap={4} wrap="nowrap">
          {connected && state.status.agent
            ? <Group gap={4} wrap="nowrap" px={4} miw={0}><AgentIcon icon={state.status.agent.icon} /><Text component="span" inherit truncate>{state.status.agent.name}</Text></Group>
            : connected || checkAcpStatus("processing")
              ? <Text size="xs" c="dimmed" px={4}>No agent</Text>
              : (
                <MenuComponent label={() => <Button variant="subtle" color="gray" size="compact-xs" fw={500} title="Start agent" rightSection={<span aria-hidden="true">▾</span>}>No agent</Button>}>
                  {query => <>
                    <TreeMenuItems query={query} text={({ agent }) => agent.description || ""} render={renderRegistryAgent}
                      items={Object.entries({ ...state.registry, custom: acp.customs }).flatMap(([kind, agents]) => agents.map(agent => ({ name: `${kind}/${agent.name}`, kind, agent })))} />
                    <MenuItemComponent leftSection={<i>{uiIcons.add}</i>} onClick={() => openSettingForm("customs")}>Add</MenuItemComponent>
                  </>}
                </MenuComponent>
              )}
          {connected ? (
            <Menu trigger="click-hover" openDelay={150} closeDelay={250} position="bottom-start" shadow="md" trapFocus={false}>
              <Menu.Target>
                <Button variant="subtle" color="gray" size="compact-xs" fw={500} title={state.session?.name || "Select session"}
                  rightSection={<span aria-hidden="true">▾</span>} style={{ flex: "1 1 0", minWidth: 0 }}
                  styles={{ inner: { minWidth: 0 }, label: { minWidth: 0 } }}
                >
                  <Text component="span" inherit truncate>{state.session?.name || "No active session"}</Text>
                </Button>
              </Menu.Target>
              <Menu.Dropdown ref={trackMenu} style={{ maxHeight: "50vh", maxWidth: "50vw", overflowY: "auto" }}>
                {state.sessions.filter(session => !session.subagent).map(session => (
                  <MenuItemComponent key={session.id} active={state.status.sessionId === session.id} onClick={() => onAcpSessionSwitch(session.id)}
                    rightSection={<>
                      {state.status.initialize?.agentCapabilities?.sessionCapabilities?.fork && <ActionIcon color="pink" onClick={e => onAcpSessionFork(e, session.id)}><i>󰘬</i></ActionIcon>}
                      {state.status.initialize?.agentCapabilities?.sessionCapabilities?.delete && <CloseButton onClick={e => onAcpSessionDelete(e, session.id)} />}
                    </>}
                  >
                    <Text component="span" inherit truncate title={session.name}>{session.name}</Text>
                  </MenuItemComponent>
                ))}
                <MenuItemComponent leftSection={<i>{uiIcons.add}</i>} title="New session" onClick={onAcpSessionCreate}>Add</MenuItemComponent>
              </Menu.Dropdown>
            </Menu>
          ) : <div className="space" />}
          {connected && <ActionIcon color={state.status.follow !== undefined ? "yellow" : "gray"} title="Follow" onClick={onAcpFollowToggle}><i>{state.status.follow !== undefined ? "󰈈" : "󰈉"}</i></ActionIcon>}
          <MenuComponent label={() => <ActionIcon title="Settings" aria-label="Settings"><i>{uiIcons.settings}</i></ActionIcon>}>
            {state.session && <>
              <MenuItemComponent leftSection={<i>{uiIcons.search}</i>} rightSection={<Text size="xs" c="dimmed">/</Text>} onClick={onSearchInput}>Search messages</MenuItemComponent>
              <Menu.Divider />
            </>}
            <SubMenuComponent label="MCP servers" leftSection={<i>{uiIcons.mcp}</i>}>
              {acp.mcpServers.map((mcp, i) => (
                <MenuItemComponent key={i} onClick={() => openSettingForm("mcpServers", i, "url" in mcp.server ? "http" : "stdio")}
                  style={mcp.enabled ? undefined : { opacity: .5 }}
                >
                  {mcp.server.name}
                </MenuItemComponent>
              ))}
              <SubMenuComponent label="Add" leftSection={<i>{uiIcons.add}</i>}>
                <MenuItemComponent onClick={() => openSettingForm("mcpServers", undefined, "stdio")}>stdio</MenuItemComponent>
                <MenuItemComponent onClick={() => openSettingForm("mcpServers", undefined, "http")}>HTTP</MenuItemComponent>
              </SubMenuComponent>
            </SubMenuComponent>
            {connected && state.status.initialize?.agentCapabilities?.auth?.logout && <MenuItemComponent leftSection={<i>󰍃</i>} onClick={onAcpAuthLogout}>Logout</MenuItemComponent>}
            {connected && <>
              <Menu.Divider />
              <MenuItemComponent color="red" leftSection={<i>{uiIcons.quit}</i>} onClick={onAcpAgentStop}>Stop agent</MenuItemComponent>
            </>}
          </MenuComponent>
        </Group>

        <Paper withBorder radius="md" className="acp-messages" data-mode={color} style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
          {state.status.status === "authenticating" ? (
            <Stack align="center" justify="center" gap={4} p="md" style={{ flex: 1 }}>
              <Text size="xs">Authentication in progress</Text>
              {!state.status.agent?.auth && state.status.initialize?.authMethods?.map(method => (
                <Button key={method.id} variant="light" color="cyan" size="xs" leftSection={<i>󰌆</i>}
                  onClick={() => onAcpAuthenticate(method)}
                >
                  {method.name}
                </Button>
              ))}
            </Stack>
          ) : state.status.sessionId ? (
            <>
              <Stack gap={0} p={6} style={{ flex: "1 1 auto", overflow: "auto" }} onScroll={onScrollContainer}>
                <MessageComponent messages={state.messages} sessionId={state.status.sessionId} sessions={sessionsById} />

                <div ref={scroll} />
              </Stack>
              <Group className="acp-search" data-visible={state.search.highlight || undefined} gap={4} wrap="nowrap">
                <TextInput ref={searchInput} size="xs" placeholder="Search messages..." leftSection={<i>{uiIcons.search}</i>} value={state.search.query}
                  onFocus={e => e.currentTarget.select()} onKeyDown={onSearchKeyDown}
                  onChange={e => { const query = e.currentTarget.value; setState(state => ({ ...state, search: { ...state.search, query, highlight: false } })); }} />
                {state.search.highlight && <Text size="xs" c="orange">{state.search.ranges.length ? `${state.search.active + 1}/${state.search.ranges.length}` : "0"}</Text>}
              </Group>
            </>
          ) : (
            <Text size="xs" c="dimmed" m="auto">No active session</Text>
          )}
        </Paper>

        {state.notice && (
          <Alert variant="light" color={({ error: "red", warning: "yellow" } as Record<string, string>)[state.notice.severity] ?? "blue"} p="xs" className="selectable"
            icon={<i>{({ error: uiIcons.error, warning: uiIcons.warning } as Record<string, string>)[state.notice.severity] ?? uiIcons.info}</i>}
            title={state.notice.title} role={state.notice.severity === "error" ? "alert" : "status"}
          >
            {state.notice.description}
          </Alert>
        )}
        {state.status.elicitation && (
          <ElicitationComponent key={state.status.elicitation.requestId} request={state.status.elicitation} />
        )}
        {state.session && <SessionPlans session={state.session} />}
        {state.status.sessionId && <McpAppsComponent sessionId={state.status.sessionId} />}

        {checkAcpStatus("connected") && (
          <Paper withBorder radius="md" p={6} className="acp-composer">
            {(state.promptContext || state.files.length > 0 || state.images.length > 0) && (
              <Group gap={4} mb={4}>
                {state.promptContext && (
                  <Badge variant="light" color="violet" tt="none" rightSection={<CloseButton onClick={() => onSetPromptContext()} />}>{state.promptContext.label}</Badge>
                )}
                {state.files.map(file => (
                  <Badge key={file} variant="light" color="gray" tt="none" title={file} leftSection={<i></i>}
                    rightSection={<CloseButton onClick={() => onRemoveFile(file)} />}
                  >{file.replace(/.*\//, "")}</Badge>
                ))}
                {state.images.map((image, index) => (
                  <Badge key={index} variant="light" color="gray" tt="none" h="auto" p={2}
                    rightSection={<CloseButton onClick={() => onRemoveImage(index)} />}
                  ><img src={`data:${image.mimeType};base64,${image.data}`} style={{ height: 32, display: "block" }} /></Badge>
                ))}
              </Group>
            )}
            <Popover opened={showCommandSuggestions} position="top-start" width="target" closeOnClickOutside={false} closeOnEscape={false}>
              <Popover.Target>
                <Box>
                  <Textarea
                    ref={textarea}
                    variant="unstyled"
                    size="xs"
                    styles={{ input: { fontSize: "inherit" } }}
                    placeholder="Type your message"
                    value={state.input}
                    onChange={e => {
                      const input = e.currentTarget.value;
                      setState(state => ({ ...state, input }));
                      setSuggestion(0);
                      setSuggestionsDismissed(false);
                    }}
                    onFocus={() => setSuggestionsDismissed(false)}
                    aria-autocomplete="list"
                    aria-controls={showCommandSuggestions ? suggestionsId : undefined}
                    aria-activedescendant={showCommandSuggestions ? `${suggestionsId}-${selectedSuggestion}` : undefined}
                    onKeyDown={onInputKeyDown}
                    onPaste={onPaste}
                    autosize
                    minRows={3}
                    maxRows={12}
                  />
                </Box>
              </Popover.Target>
              <Popover.Dropdown p={4}>
                <Stack id={suggestionsId} role="listbox" aria-label="Slash commands" gap={2} mah={200} style={{ overflowY: "auto" }}>
                  {commandSuggestions.map((command, index) => (
                    <UnstyledButton key={command.name} id={`${suggestionsId}-${index}`} role="option" aria-selected={index === selectedSuggestion}
                      tabIndex={-1} px={8} py={4}
                      style={{
                        flexShrink: 0, borderRadius: "var(--mantine-radius-sm)", overflowWrap: "anywhere",
                        background: index === selectedSuggestion ? "var(--mantine-primary-color-light)" : undefined,
                      }}
                      onMouseDown={event => event.preventDefault()} onClick={() => selectCommandSuggestion(command.name)}
                    >
                      <Text size="xs" fw={500}>/{command.name}</Text>
                      {command.description && <Text size="xs" c="dimmed">{command.description}</Text>}
                    </UnstyledButton>
                  ))}
                </Stack>
              </Popover.Dropdown>
            </Popover>
            <Group gap={4} wrap="nowrap" align="flex-end">
              <Group gap={4} style={{ flex: 1, minWidth: 0 }}>
              {state.session && state.session.commands.length > 0 && (
                <MenuComponent label={() => <Button {...chipProps(false)} c="green">/</Button>}>
                  {state.session.commands.map((command) => (
                    <MenuItemComponent key={command.name} title={command.description}
                      onClick={() => onSetPromptContext({ label: `/${command.name}`, value: `/${command.name}` })}>
                      /{command.name}
                    </MenuItemComponent>
                  ))}
                </MenuComponent>
              )}
                {state.session?.configOptions?.map(renderConfigOption)}
              </Group>
              <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
                {checkAcpStatus("processing") && <Loader size="1em" />}
                {checkAcpStatus("processing") ? (
                  <ActionIcon variant="light" color="red" title="Cancel" onClick={onAcpPromptCancel}>
                    <i>{uiIcons.stop}</i>
                  </ActionIcon>
                ) : (
                  <ActionIcon variant="filled" title="Send" onClick={onConfirmInput}><i>󰒊</i></ActionIcon>
                )}
              </Group>
            </Group>
          </Paper>
        )}

        {state.session?.usage && (
          <Group gap={6} px={4} c="dimmed" fz={10} wrap="nowrap">
            <UsageComponent {...state.session.usage} />
            {state.session.usage.cost && <span>{state.session.usage.cost.amount.toLocaleString()} {state.session.usage.cost.currency}</span>}
          </Group>
        )}
      </Stack>
    </FocusProvider>
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function UsageComponent({ used, size }: { used: number; size: number }) {
  const ratio = size > 0 ? used / size : 0;
  const color = ratio < 0.6 ? "green" : ratio < 0.85 ? "yellow" : "red";

  return (
    <Tooltip label={`${used.toLocaleString()} / ${size.toLocaleString()} tokens (${(ratio * 100).toFixed(1)}%)`} fz="xs" withArrow>
      <Group gap={6} wrap="nowrap" flex={1} miw={0}>
        <Progress value={ratio * 100} color={color} size={4} radius="xl" flex={1} />
        <span style={{ whiteSpace: "nowrap" }}>{compact.format(used)} / {compact.format(size)}</span>
      </Group>
    </Tooltip>
  );
}
