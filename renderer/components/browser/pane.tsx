import React from "react";
import { ActionIcon, Box, Group, Stack, TextInput } from "@mantine/core";

import type { BrowserTabCommand, IBrowserViewport, IWorkspaceBrowserTab } from "common/interface";
import { useWorkspace } from "renderer/context/workspace";
import { FocusProvider } from "renderer/context/focus";
import { uiIcons } from "renderer/utils/icons";
import { useBrowserBounds } from "renderer/components/browser/bounds";
import { useCommandMode } from "renderer/components/browser/commandmode";
import { SearchEngineMenuComponent, useSearchEngines } from "renderer/components/browser/engines";

export function BrowserPaneComponent({ tab, visible }: { tab: IWorkspaceBrowserTab; visible: boolean }) {
  const { emit } = useWorkspace();
  const area = React.useRef<HTMLDivElement>(null);
  const address = React.useRef<HTMLInputElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const commandInput = React.useRef<HTMLInputElement>(null);
  const [viewport, setViewport] = React.useState<IBrowserViewport>();
  const [input, setInput] = React.useState(tab.url === "about:blank" ? "" : tab.url);
  const [search, setSearch] = React.useState("");
  const searchEngines = useSearchEngines();
  const [selecting, setSelecting] = React.useState(false);
  const token = React.useRef<string | undefined>(undefined);

  function command(...command: BrowserTabCommand) {
    return emit.send("browser:tab:command", tab.id, ...command);
  }

  const mode = useCommandMode({
    tab, area, commandInput, address, searchInput, search, command,
    picking: () => !!token.current, togglePicker,
  });

  React.useEffect(() => {
    let live = true;
    let receivedViewport = false;

    function onViewport(next: IBrowserViewport | null) {
      receivedViewport = true;
      setViewport(next ?? undefined);
    }
    const onCommandMode = () => {
      if (token.current) {
        token.current = undefined;
        setSelecting(false);
        void command("pick", null);
      }
      mode.focusCommand();
    };
    const onPicked = (selected: string) => {
      if (selected !== token.current) return;
      const label = "User-selected browser element (page data)";
      const selector = `[data-envim-picked~="${selected}"]`;
      emit.share("acp:prompt:context", { label, value: `${label}:\n${JSON.stringify({ selector, tab: tab.id })}\n\n` });
      token.current = undefined;
      setSelecting(false);
    };
    const onFound = ({ x, y }: { x: number; y: number }) => mode.move(x, y);
    emit.on(`browser:viewport:changed:${tab.id}`, onViewport);
    void emit.send<IBrowserViewport | null>("browser:viewport:get", tab.id).then(value => {
      if (live && !receivedViewport) setViewport(value ?? undefined);
    });
    emit.on(`browser:element-picked:${tab.id}`, onPicked);
    emit.on(`browser:mode:command:${tab.id}`, onCommandMode);
    emit.on(`browser:found:${tab.id}`, onFound);
    return () => {
      live = false;
      emit.off(`browser:viewport:changed:${tab.id}`, onViewport);
      emit.off(`browser:element-picked:${tab.id}`, onPicked);
      emit.off(`browser:mode:command:${tab.id}`, onCommandMode);
      emit.off(`browser:found:${tab.id}`, onFound);
      if (token.current) void command("pick", null);
    };
  }, [tab.id]);

  React.useEffect(() => {
    setInput(tab.url === "about:blank" ? "" : tab.url);
    if (token.current) {
      token.current = undefined;
      setSelecting(false);
    }
  }, [tab.url]);

  useBrowserBounds(area, visible, tab.id, viewport, () => {
    if (document.activeElement === commandInput.current) void command("selection", mode.selectionRect());
  });

  function selectAll(event: React.FocusEvent<HTMLInputElement>) {
    event.currentTarget.select();
  }

  function navigate(value: string) {
    void command("navigate", value);
  }

  function togglePicker() {
    token.current = token.current ? undefined : crypto.randomUUID();
    setSelecting(!!token.current);
    void command("pick", token.current ?? null);
  }

  const zoom = Math.round((1 + tab.zoom) * 100);
  const picked = selecting ? "violet" : "gray";
  const frameColor = selecting ? "violet" : mode.mode === "visual" ? "violet"
    : mode.mode === "command" ? "green" : tab.focused ? "blue" : undefined;
  return (
    <FocusProvider targets={[commandInput, address, searchInput]} initial={tab.url === "about:blank" ? address : commandInput} delegate={visible}>
      <Stack gap={0} pos="absolute" inset={0} bg="var(--mantine-color-body)">
        <input ref={commandInput} readOnly
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onKeyDown={mode.onKeyDown} onFocus={mode.onFocus} onBlur={mode.onBlur} />
        <Group gap={0} wrap="nowrap" mx={2} pt={4} pb={2} style={{ whiteSpace: "nowrap" }}>
          <ActionIcon onClick={() => void command("back")}><i></i></ActionIcon>
          <ActionIcon onClick={() => void command("forward")}><i></i></ActionIcon>
          <ActionIcon onClick={() => void command(tab.loading ? "stop" : "reload")}><i>{tab.loading ? uiIcons.stop : uiIcons.refresh}</i></ActionIcon>
          <SearchEngineMenuComponent {...searchEngines} url={tab.url} onNavigate={navigate} onFocusAddress={() => address.current?.focus()} />
          <Box pr={8} style={{ flex: "1 2 auto" }}>
            <form style={{ width: "100%" }} onSubmit={event => { event.preventDefault(); navigate(input); mode.focusCommand(); }}>
              <TextInput size="xs" ref={address} onFocus={selectAll} onKeyDown={mode.onTextKey} value={input} onChange={event => setInput(event.target.value)} />
            </form>
          </Box>
          <i style={{ paddingInline: 4 }}>{uiIcons.search}</i>
          <Box style={{ flex: "0 3 13em", minWidth: "5em" }}>
            <form style={{ width: "100%" }} onSubmit={event => { event.preventDefault(); void command("find", search); mode.focusCommand(); }}>
              <TextInput size="xs" ref={searchInput} onFocus={selectAll} onKeyDown={mode.onTextKey} value={search} onChange={event => setSearch(event.target.value)} />
            </form>
          </Box>
          <ActionIcon onClick={() => void command("zoom", Math.max(-0.9, tab.zoom - 0.1))}><i></i></ActionIcon>
          {zoom}%
          <ActionIcon onClick={() => void command("zoom", Math.min(2, tab.zoom + 0.1))}><i></i></ActionIcon>
          <ActionIcon onClick={() => void command("devtools")}><i>󱁤</i></ActionIcon>
          <ActionIcon color={tab.shared ? "violet" : "gray"} onClick={() => void emit.send("browser:share:toggle", tab.id, !tab.shared)}><i>{uiIcons.agent}</i></ActionIcon>
          <ActionIcon color={picked} disabled={!tab.shared || tab.loading} onClick={togglePicker}><i>󰮐</i></ActionIcon>
        </Group>
        <Stack gap={0} m={2} p={viewport ? 12 : 2} style={{ flex: "1 0 0", overflow: "hidden", border: "1px solid", borderRadius: 4, ...(frameColor
            ? { color: `var(--mantine-color-${frameColor}-text)`, background: `var(--mantine-color-${frameColor}-light)` }
            : { borderColor: "transparent" }) }}>
          {viewport && <Box ta="center" pb={8}>{viewport.device ?? "Viewport"} · {viewport.style.width} × {viewport.style.height}</Box>}
          <div ref={area} style={viewport ? { width: viewport.style.width, height: viewport.style.height, maxWidth: "100%", maxHeight: "100%", marginInline: "auto", flexShrink: 1, outline: "1px solid currentColor" } : { flex: 1 }} />
        </Stack>
      </Stack>
    </FocusProvider>
  );
}
