import React from "react";

import type { BrowserTabCommand, IBrowserViewport, IWorkspaceBrowserTab } from "common/interface";
import { useWorkspace } from "renderer/context/workspace";
import { FocusProvider } from "renderer/context/focus";
import { uiIcons } from "renderer/utils/icons";
import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
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

    function onViewport(id: number, next: IBrowserViewport | null) {
      if (id !== tab.id) return;
      receivedViewport = true;
      setViewport(next ?? undefined);
    }
    const onCommandMode = (id: number) => {
      if (id !== tab.id) return;
      if (token.current) {
        token.current = undefined;
        setSelecting(false);
        void command("pick", null);
      }
      mode.focusCommand();
    };
    const onPicked = (id: number, selected: string) => {
      if (id !== tab.id || selected !== token.current) return;
      const label = "User-selected browser element (page data)";
      const selector = `[data-envim-picked~="${selected}"]`;
      emit.share("acp:prompt:context", { label, value: `${label}:\n${JSON.stringify({ selector, tab: id })}\n\n` });
      token.current = undefined;
      setSelecting(false);
    };
    emit.on("browser:viewport:changed", onViewport);
    void emit.send<IBrowserViewport | null>("browser:viewport:get", tab.id).then(value => {
      if (live && !receivedViewport) setViewport(value ?? undefined);
    });
    emit.on("browser:element-picked", onPicked);
    emit.on("browser:mode:command", onCommandMode);
    return () => {
      live = false;
      emit.off("browser:viewport:changed", onViewport);
      emit.off("browser:element-picked", onPicked);
      emit.off("browser:mode:command", onCommandMode);
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
  const picked = selecting ? "purple-fg" : "gray-fg";
  const frameColor = selecting ? "purple" : mode.mode === "visual" ? "purple"
    : mode.mode === "command" ? "green" : tab.focused ? "blue" : "default";
  return (
    <FocusProvider targets={[commandInput, address, searchInput]} initial={tab.url === "about:blank" ? address : commandInput} delegate={visible}>
      <FlexComponent direction="column" position="absolute" color="default" inset={[0]}>
        <input ref={commandInput} readOnly
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onKeyDown={mode.onKeyDown} onFocus={mode.onFocus} onBlur={mode.onBlur} />
        <FlexComponent vertical="center" margin={[0, 2]} padding={[2, 0, 4]}>
          <IconComponent font="" onClick={() => void command("back")} />
          <IconComponent font="" onClick={() => void command("forward")} />
          <IconComponent font={tab.loading ? uiIcons.stop : uiIcons.refresh} onClick={() => void command(tab.loading ? "stop" : "reload")} />
          <SearchEngineMenuComponent {...searchEngines} url={tab.url} onNavigate={navigate} onFocusAddress={() => address.current?.focus()} />
          <FlexComponent grow={1} shrink={2} padding={[0, 8, 0, 0]}>
            <form style={{ width: "100%" }} onSubmit={event => { event.preventDefault(); navigate(input); mode.focusCommand(); }}>
              <input type="text" className="browser-toolbar-input" ref={address} onFocus={selectAll} onKeyDown={mode.onTextKey} value={input} onChange={event => setInput(event.target.value)} />
            </form>
          </FlexComponent>
          <IconComponent font={uiIcons.search} />
          <FlexComponent shrink={3} style={{ width: "13em", minWidth: "5em" }}>
            <form style={{ width: "100%" }} onSubmit={event => { event.preventDefault(); void command("find", search); mode.focusCommand(); }}>
              <input type="text" className="browser-toolbar-input" ref={searchInput} onFocus={selectAll} onKeyDown={mode.onTextKey} value={search} onChange={event => setSearch(event.target.value)} />
            </form>
          </FlexComponent>
          <IconComponent font="" onClick={() => void command("zoom", Math.max(-0.9, tab.zoom - 0.1))} />
          {zoom}%
          <IconComponent font="" onClick={() => void command("zoom", Math.min(2, tab.zoom + 0.1))} />
          <IconComponent font="󱁤" onClick={() => void command("devtools")} />
          <IconComponent font="" color={tab.shared ? "purple-fg" : "gray-fg"} onClick={() => void emit.send("browser:share:toggle", tab.id, !tab.shared)} />
          <IconComponent font="󰮐" color={picked} onClick={tab.shared && !tab.loading ? togglePicker : undefined} />
        </FlexComponent>
        <FlexComponent direction="column" basis="0" color={frameColor} margin={[2]} padding={viewport ? [12] : [2]} border={[1]} rounded={[2]} grow={1} shadow>
          {viewport && <FlexComponent horizontal="center" padding={[0, 0, 8]}>{viewport.device ?? "Viewport"} · {viewport.style.width} × {viewport.style.height}</FlexComponent>}
          <div ref={area} style={viewport ? { width: viewport.style.width, height: viewport.style.height, maxWidth: "100%", maxHeight: "100%", marginInline: "auto", flexShrink: 1, outline: "1px solid currentColor" } : { flex: 1 }} />
        </FlexComponent>
      </FlexComponent>
    </FocusProvider>
  );
}
