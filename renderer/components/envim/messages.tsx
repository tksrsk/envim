import React from "react";
import { ActionIcon, CloseButton, Group, Stack, Text } from "@mantine/core";

import { IMessage } from "common/interface";
import { IFormRequest, schema } from "common/schema";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";

import { trackMenu } from "renderer/components/menu";
import { Emit } from "renderer/utils/emit";
import { notificates, uiIcons } from "renderer/utils/icons";

interface States {
  messages: IMessage[];
  notifications: IMessage[];
  notificationsEnabled?: boolean;
  open: boolean;
  debugFilter?: RegExp;
  mode?: IMessage;
  command?: IMessage;
  ruler?: IMessage;
}

export function MessagesComponent() {
  const { options } = useEditor();
  const { emit, highlights } = useWorkspace();
  const [state, setState] = React.useState<States>({ messages: [], notifications: [], notificationsEnabled: options.ext_messages, open: false });
  const { messages, notifications, notificationsEnabled, open, mode, command, ruler, debugFilter } = state;
  const list = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    emit.on("neovim:ui:messages:show", onNeovimUiMessagesShow);
    emit.on("neovim:ui:messages:history", onNeovimUiMessagesHistory);
    emit.on("history:toggle", onHistoryToggle);
    emit.on("neovim:ui:messages:mode", onNeovimUiMessagesMode);
    emit.on("neovim:ui:messages:command", onNeovimUiMessagesCommand);
    emit.on("neovim:ui:messages:ruler", onNeovimUiMessagesRuler);
    emit.on("debug:filter", onDebugFilter);
    return () => {
      emit.off("neovim:ui:messages:show", onNeovimUiMessagesShow);
      emit.off("neovim:ui:messages:history", onNeovimUiMessagesHistory);
      emit.off("history:toggle", onHistoryToggle);
      emit.off("neovim:ui:messages:mode", onNeovimUiMessagesMode);
      emit.off("neovim:ui:messages:command", onNeovimUiMessagesCommand);
      emit.off("neovim:ui:messages:ruler", onNeovimUiMessagesRuler);
      emit.off("debug:filter", onDebugFilter);
    };
  }, [emit]);

  React.useEffect(() => {
    emit.share("history:visibility", open);
  }, [emit, open]);

  React.useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, messages]);

  React.useEffect(() => {
    const enabled = options.ext_messages;
    if (enabled !== undefined) setState(state => ({ ...state, notificationsEnabled: enabled }));
  }, [options.ext_messages]);

  React.useEffect(() => {
    if (!debugFilter) return;

    function onDebug(direction: "send" | "receive", event: string, ...args: unknown[]) {
      if (!debugFilter?.test(`${direction} ${event}`)) return;

      const message: IMessage = {
        kind: "debug",
        contents: [
          direction === "send" ? { hl: "ui:yellow", content: `[ 󰕒${event} ]` } : { hl: "ui:blue", content: `[ 󰇚 ${event} ]` },
          { hl: "0", content: `\n${JSON.stringify(args, null, 2)}` },
        ],
      };
      emit.share("neovim:ui:messages:history", [message], false);
    }

    Emit.on("debug", onDebug);
    return () => Emit.off("debug", onDebug);
  }, [emit, debugFilter]);

  function promptDebugFilter() {
    emit.share("form:open", {
      title: `${uiIcons.debug} Debug`,
      schema: schema.object({ filter: schema.string("Event name", { description: "Regular expression; leave empty to stop" }) }),
      values: { filter: debugFilter?.source ?? "" },
      actions: [{ action: "apply", name: "Apply", color: "blue", font: uiIcons.accept, submit: true }],
      reply: { event: "debug:filter", via: "share" },
    } satisfies IFormRequest);
  }

  function onDebugFilter(action?: string, values?: { filter?: string }) {
    if (action !== "apply") return;

    const filter = values?.filter;

    try {
      const debugFilter = filter ? new RegExp(filter) : undefined;
      setState(state => ({ ...state, debugFilter }));
    } catch (error) {
      if (error instanceof Error) {
        emit.share("neovim:ui:messages:history", [{ kind: "debug", contents: [{ hl: "ui:red", content: error.message }] }], false);
      }
    }
  }

  function onNeovimUiMessagesShow(notifications: IMessage[]) {
    setState(state => ({ ...state, notifications }));
  }

  function onHistoryToggle(visible?: boolean) {
    setState(state => ({ ...state, open: visible ?? !state.open }));
  }

  function onClose() {
    onHistoryToggle(false);
  }

  function onNeovimUiMessagesHistory(incoming: IMessage[], replace: boolean) {
    setState(state => {
      const history = replace ? [] : [...state.messages];
      for (const message of incoming) {
        const last = message.append && history.pop();
        history.push(last ? { ...message, contents: [...last.contents, ...message.contents] } : message);
      }
      return { ...state, messages: history.slice(-1000) };
    });
  }

  function onNeovimUiMessagesMode(message: IMessage) {
    setState(state => ({ ...state, mode: message.contents.length ? message : undefined }));
  }

  function onNeovimUiMessagesCommand(message: IMessage) {
    setState(state => ({ ...state, command: message.contents.length ? message : undefined }));
  }

  function onNeovimUiMessagesRuler(message: IMessage) {
    setState(state => ({ ...state, ruler: message.contents.length ? message : undefined }));
  }

  const { background, color } = highlights.style("0");
  const surfaceStyle = { background, color };

  const status = (mode || command || ruler) && (
    <div className="envim-message-status" style={open ? undefined : surfaceStyle}>
      {mode && <MessageComponent message={mode} singleLine />}
      {command && <MessageComponent message={command} singleLine />}
      {ruler && <MessageComponent message={ruler} singleLine />}
    </div>
  );

  if (!open) {
    return (status || (notificationsEnabled && notifications.length > 0)) && (
      <Stack gap={2} className="envim-notifications">
        {notificationsEnabled && notifications.map((message, i) => (
          <div key={i} className="envim-notification" style={surfaceStyle}><MessageComponent message={message} collapsible /></div>
        ))}
        {status}
      </Stack>
    );
  }

  return (
    <div ref={trackMenu} role="region" aria-label="Message history" className="envim-history-panel" style={surfaceStyle}
      onKeyDown={e => e.key === "Escape" && onClose()}>
      <Group className="envim-history-header" justify="space-between" wrap="nowrap">
        <Text fw={600} size="sm">Message history</Text>
        <Group gap={4} wrap="nowrap">
          <ActionIcon size="xs" color="green" variant={debugFilter ? "light" : "subtle"} title="Debug filter" aria-label="Debug filter"
            onClick={promptDebugFilter}>
            <i aria-hidden="true">{uiIcons.debug}</i>
          </ActionIcon>
          <ActionIcon size="xs" color="red" variant="subtle" aria-label="Clear message history" title="Clear message history" disabled={!messages.length} onClick={() => setState(state => ({ ...state, messages: [] }))}>
            <i aria-hidden="true"></i>
          </ActionIcon>
          <CloseButton size="xs" aria-label="Close message history" title="Close message history" onClick={onClose} />
        </Group>
      </Group>
      <div ref={list} className="envim-history-list">
        {messages.length === 0 && <Text size="sm" c="dimmed" px={8} py={6}>No messages</Text>}
        {messages.map((message, i) => (
          <div key={i} className="envim-history-item">
            <MessageComponent message={message} />
          </div>
        ))}
      </div>
      {status}
    </div>
  );
}

function getNotificate(kind: string) {
  return notificates.find(icon => icon.kinds.includes(kind)) || { font: "󱈸", color: "gray" };
}

interface MessageProps {
  message: IMessage;
  collapsible?: boolean;
  singleLine?: boolean;
}

interface MessageStates {
  open: boolean;
}

function MessageComponent(props: MessageProps) {
  const { highlights } = useWorkspace();
  const { collapsible = false, singleLine = false } = props;
  const [state, setState] = React.useState<MessageStates>({ open: true });
  const { font, color } = getNotificate(props.message.kind);
  const background = highlights.color("0", "background");

  function onToggleOpen() {
    setState(state => ({ ...state, open: !state.open }));
  }

  function contentStyle(hl: string) {
    if (hl.startsWith("ui:")) {
      return { color: `var(--mantine-color-${hl.slice(3)}-text)` };
    }

    const style = highlights.style(hl);
    return { ...style, background: style.background === background ? undefined : style.background };
  }

  return (
    <div className="envim-message" data-collapsible={collapsible || undefined} onClick={collapsible ? onToggleOpen : undefined}>
      <i className="envim-message-icon" style={{ color: `var(--mantine-color-${color}-text)` }}>{font}</i>
      <div className="selectable envim-message-body" style={{ whiteSpace: singleLine || (collapsible && !state.open) ? "nowrap" : "pre-wrap" }}>
        <div className="envim-message-text">
          {props.message.contents.map(({hl, content}, i) => <span style={contentStyle(hl)} key={i}>{ content }</span>)}
        </div>
      </div>
    </div>
  );
}
