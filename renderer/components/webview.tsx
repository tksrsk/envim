import * as Electron from "electron";
import React from "react";

import { MOCK_PREVIEW_ORIGIN_PREFIX, MOCK_PREVIEW_SCHEME } from "common/constant";
import { IAcpStatus, ISetting } from "common/interface";

import { useWorkspace } from "renderer/context/workspace";
import { useFocus, FocusProvider } from "renderer/context/focus";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { uiIcons } from "renderer/utils/icons";
import { col2X, row2Y } from "renderer/utils/size";

import { FlexComponent } from "renderer/components/flex";
import { MenuComponent } from "renderer/components/menu";
import { IconComponent } from "renderer/components/icon";

interface Props {
  src: string;
  requestId?: string;
  active: boolean;
  style: React.CSSProperties;
}

interface States {
  input: string;
  search: string;
  title: string;
  loading: boolean;
  favicon?: string;
  searchengines: ISetting["searchengines"];
  zoom: number;
  pointer: Electron.Rectangle;
  selection?: { anchor: { x: number; y: number; }; rect: Electron.Rectangle; line: boolean };
}

const styles: { [k: string]: React.CSSProperties } = {
  command: {
    position: "absolute",
    width: 0,
    height: 0,
    padding: 0,
  },
  form: {
    width: "100%",
  },
  input: {
    width: "100%",
  },
  title: {
    maxWidth: 200,
  },
};

export function WebviewComponent(props: Props) {
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<States>({ input: props.src, search: "", title: "", loading: false, searchengines: Setting.searchengines, zoom: 100, pointer: { x: 0, y: 0, width: col2X(1), height: row2Y(1) } });
  const container: React.RefObject<HTMLDivElement | null> = React.useRef<HTMLDivElement>(null);
  const webview: React.RefObject<Electron.WebviewTag | null> = React.useRef<Electron.WebviewTag>(null);
  const input: React.RefObject<HTMLInputElement | null> = React.useRef<HTMLInputElement>(null);
  const search: React.RefObject<HTMLInputElement | null> = React.useRef<HTMLInputElement>(null);
  const command: React.RefObject<HTMLInputElement | null> = React.useRef<HTMLInputElement>(null);
  const [shared, setShared] = React.useState(false);
  const [acpStatus, setAcpStatus] = React.useState<IAcpStatus>({ status: "disconnected" });
  const [pickerId, setPickerId] = React.useState<number>();
  const { active } = useFocus();
  const mode = getMode(active);
  const currentUrl = webview.current?.getURL() ?? getUrl(props.src);
  const blank = currentUrl === "about:blank";
  const mock = currentUrl.startsWith(MOCK_PREVIEW_ORIGIN_PREFIX);
  const webPage = /^https?:\/\//.test(currentUrl);
  const agentIcon = acpStatus.status === "disconnected" ? undefined : acpStatus.agent?.icon;
  const acpReady = (acpStatus.status === "connected" || acpStatus.status === "processing") &&
    !!acpStatus.sessionId && !!acpStatus.initialize?.agentCapabilities?.mcpCapabilities?.http;
  const selecting = pickerId !== undefined;
  const canSelect = acpReady && (mock || (webPage && shared)) && !state.loading;
  const canToggleSelection = selecting || canSelect;
  const canToggleSharing = shared || !state.loading;
  const shareIconStyle = {
    opacity: canToggleSharing ? 1 : 0.5,
    ...(agentIcon && {
      "--color-fg": shared ? "var(--color-purple)" : "var(--color-gray)",
      height: "calc(1em + 8px)",
    }),
  } as React.CSSProperties;
  const icon = state.searchengines.some(({ uri }) => uri === state.input)
    ? { color: "blue-fg", font: "" }
    : { color: "gray-fg", font: "" };
  const color = pickerId !== undefined ? "purple" : { command: "green", visual: "purple", browser: "blue" }[mode] || "default";

  React.useEffect(() => {
    Emit.on("browser:action", onBrowserAction);
    Emit.on("browser:searchengines", onBrowserSearchengines);

    return () => {
      Emit.off("browser:action", onBrowserAction);
      Emit.off("browser:searchengines", onBrowserSearchengines);
    };
  }, []);

  React.useEffect(() => {
    setShared(false);
    setPickerId(undefined);
    if (container.current) {
      const guest = document.createElement("webview") as Electron.WebviewTag;

      guest.setAttribute("allowpopups", "on");
      guest.addEventListener("dom-ready", onReady);
      if (props.requestId) guest.addEventListener("did-finish-load", onShareReady);
      guest.src = getUrl(props.src);
      container.current.appendChild(guest);

      return () => {
        guest.removeEventListener("dom-ready", onReady);
        guest.removeEventListener("did-finish-load", onShareReady);
        guest.removeEventListener("close", onClose);
        guest.removeEventListener("did-start-loading", onLoad);
        guest.removeEventListener("did-stop-loading", onLoad);
        guest.removeEventListener("did-finish-load", onLoad);
        guest.removeEventListener("did-navigate", onLoad);
        guest.removeEventListener("did-navigate-in-page", onLoad);
        guest.removeEventListener("page-title-updated", onLoad);
        guest.removeEventListener("page-favicon-updated", onFavicon);
        guest.remove();
        if (webview.current === guest) webview.current = null;
      };
    }

    return;
  }, [props.src, props.requestId]);

  React.useEffect(() => {
    webview.current && Emit.send(`browser:mode:${webview.current.getWebContentsId()}`, mode);
    ["input", "search"].includes(mode) && (document.activeElement as HTMLInputElement).select();
    ["command", "visual"].includes(mode) || setState(state => state.selection ? { ...state, selection: undefined } : state);
  }, [mode]);

  React.useEffect(() => {
    let waitingForStatus = true;
    function onAcpStatus(status: IAcpStatus) {
      waitingForStatus = false;
      setAcpStatus(status);
    }

    function finish(id: number) {
      setPickerId(current => current === id ? undefined : current);
    }

    function onShare(id: number, value: boolean) {
      if (webview.current?.getWebContentsId() !== id) return;
      setShared(value);
    }

    emit.on("browser:pick:finished", finish);
    emit.on("browser:share:status", onShare);
    emit.on("acp:status:changed", onAcpStatus);
    void emit.send<IAcpStatus>("acp:status:get").then(status => {
      if (status && waitingForStatus) onAcpStatus(status);
    });
    return () => {
      waitingForStatus = false;
      emit.off("browser:pick:finished", finish);
      emit.off("browser:share:status", onShare);
      emit.off("acp:status:changed", onAcpStatus);
    };
  }, [emit]);

  function selectElement() {
    if (!webview.current) return;

    const id = webview.current.getWebContentsId();
    const enable = pickerId === undefined;
    if (enable) setPickerId(id);
    void emit.send("browser:pick", id, enable);
  }

  function getMode(element: Element | null) {
    switch (element) {
      case null: return "blur";
      case command.current: return state.selection ? "visual" : "command";
      case input.current: return "input";
      case search.current: return "search";
      case webview.current: return "browser";
      default: return "blur";
    }
  }

  function onShareReady(event: Event) {
    const guest = event.currentTarget as Electron.WebviewTag;
    guest.removeEventListener("did-finish-load", onShareReady);
    if (props.requestId) void emit.send("browser:share:ready", props.requestId, guest.getWebContentsId());
  }

  function onReady(event: Event) {
    if (event.currentTarget) {
      webview.current = event.currentTarget as Electron.WebviewTag;
      webview.current.removeEventListener("dom-ready", onReady);
      webview.current.addEventListener("did-start-loading", onLoad);
      webview.current.addEventListener("did-stop-loading", onLoad);
      webview.current.addEventListener("did-finish-load", onLoad);
      webview.current.addEventListener("did-navigate", onLoad);
      webview.current.addEventListener("did-navigate-in-page", onLoad);
      webview.current.addEventListener("page-title-updated", onLoad);
      webview.current.addEventListener("page-favicon-updated", onFavicon);
      webview.current.addEventListener("close", onClose);
      onLoad();
      if (props.src.startsWith(MOCK_PREVIEW_ORIGIN_PREFIX)) {
        void emit.send("browser:mock:ready", props.src, webview.current.getWebContentsId()).catch(console.error);
      }
    }
  }

  function getUrl(input: string) {
    input = input.trim();

    if (!input || input === "about:blank") {
      return "about:blank";
    } else if (input.search(new RegExp(`^(((https?)|(file)|(${MOCK_PREVIEW_SCHEME})):\\/\\/)|(data:.*\\/.*;base64)`)) === 0) {
      return input;
    } else {
      const selected = state.searchengines.find(({ selected }) => selected);

      return selected?.uri.replace("${query}", encodeURIComponent(input)) || "about:blank";
    }
  }

  function onClose() {
    webview.current = null;
    setShared(false);
  }

  function setPointer(x: number | "max", y: number | "max") {
    if (!webview.current || !container.current) return;
    x = Math.min(Math.max(x === "max" ? container.current.offsetWidth : x, 0), container.current.offsetWidth - state.pointer.width);
    y = Math.min(Math.max(y === "max" ? container.current.offsetHeight : y, 0), container.current.offsetHeight - state.pointer.height);

    const pointer = { ...state.pointer, x, y };
    const selection = (() => {
      if (!state.selection) return;
      const x = state.selection.line ? 0 : Math.min(state.selection.anchor.x, pointer.x);
      const y = Math.min(state.selection.anchor.y, pointer.y);
      const width = state.selection.line ? container.current.offsetWidth : Math.abs(state.selection.anchor.x - pointer.x) + pointer.width;
      const height = Math.abs(state.selection.anchor.y - pointer.y) + pointer.height;

      return { ...state.selection, rect: { x, y, width, height } };
    })();

    webview.current.sendInputEvent({ type: "mouseMove", x, y });
    setState(state => ({ ...state, pointer, selection }));
  }

  function switchVisualMode(mode: "command" | "visual" | "visual-line", capture?: "full" | "selected") {
    const line = mode === "visual-line";

    if (!webview.current || !container.current) return;
    if (state.selection?.line === line) mode = "command";
    if (mode === "visual-line") mode = "visual";
    if (capture && state.selection) Emit.send(`browser:capture:${webview.current.getWebContentsId()}`, { selected: state.selection.rect }[capture]);

    const rect = line ? { ...state.pointer, x: 0, width: container.current.offsetWidth } : state.pointer;
    const anchor = { ...state.pointer }

    setState(state => ({ ...state, selection: mode === "command" ? undefined : { anchor, line, rect } }));
  }

  function renderRect() {
    const rect = mode === "command" ? state.pointer : mode === "visual" ? state.selection?.rect : undefined;

    if (!rect) return null;

    const style = { backdropFilter: "invert(1)", transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height };

    return <FlexComponent animate="fade-in" position="absolute" inset={[0, "auto", "auto", 0]} style={style} shadow nomouse />;
  }

  function clickPointer() {
    if (!webview.current) return;

    webview.current.sendInputEvent({ type: "mouseDown", button: "left", x: state.pointer.x, y: state.pointer.y, clickCount: 1 });
    webview.current.sendInputEvent({ type: "mouseUp", button: "left", x: state.pointer.x, y: state.pointer.y, clickCount: 1 });
    (webview.current as HTMLElement).addEventListener("focus", () => runAction("mode-command"), { once: true });
  }

  function onKeyDown (e: React.KeyboardEvent) {
    const modkey = e.ctrlKey || e.metaKey;

    e.stopPropagation();
    e.preventDefault();

    if (!webview.current || e.nativeEvent.isComposing) return;

    switch (modkey && e.key) {
      case "r": return runAction("reload");
      case "o": return runAction("navigate-backward");
      case "i": return runAction("navigate-forward");
      case "h": return webview.current.sendInputEvent({ type: "mouseWheel", x: state.pointer.x, y: state.pointer.y, deltaX: 100, deltaY: 0 });
      case "j": return webview.current.sendInputEvent({ type: "mouseWheel", x: state.pointer.x, y: state.pointer.y, deltaX: 0, deltaY: -100 });
      case "k": return webview.current.sendInputEvent({ type: "mouseWheel", x: state.pointer.x, y: state.pointer.y, deltaX: 0, deltaY: 100 });
      case "l": return webview.current.sendInputEvent({ type: "mouseWheel", x: state.pointer.x, y: state.pointer.y, deltaX: -100, deltaY: 0 });
      case "u": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "PageUp" });
      case "d": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "PageDown" });
      case "s": return emit.send("browser:open", "", "new");
      case "v": return emit.send("browser:open", "", "vnew");
      case "t": return emit.send("browser:open", "", "tabnew");
    }

    switch (e.key) {
      case "h": return setPointer(state.pointer.x - col2X(1), state.pointer.y);
      case "j": return setPointer(state.pointer.x, state.pointer.y + row2Y(1));
      case "k": return setPointer(state.pointer.x, state.pointer.y - row2Y(1));
      case "l": return setPointer(state.pointer.x + col2X(1), state.pointer.y);
      case "H": return setPointer(state.pointer.x, 0);
      case "M": return setPointer(state.pointer.x, Math.floor((container.current?.offsetHeight ?? 0) / 2));
      case "L": return setPointer(state.pointer.x, "max");
      case "0": return setPointer(0, state.pointer.y);
      case "$": return setPointer("max", state.pointer.y);
      case "b": return setPointer(state.pointer.x - col2X(15), state.pointer.y);
      case "w": return setPointer(state.pointer.x + col2X(15), state.pointer.y);
      case "N": return runAction(state.search ? "search-backward" : "search-stop");
      case "n": return runAction(state.search ? "search-forward" : "search-stop");
      case "g": return (webview.current.sendInputEvent({ type: "keyDown", keyCode: "Home" }), setPointer(state.pointer.x, 0));
      case "G": return (webview.current.sendInputEvent({ type: "keyDown", keyCode: "End" }), setPointer(state.pointer.x, "max"));
      case "v": return switchVisualMode("visual");
      case "V": return switchVisualMode("visual-line");
      case "y": return mode === "visual" && switchVisualMode("command", "selected");
      case "Y": return mode === "command" && switchVisualMode("command", "full");
      case "-": return runAction("zoom-out");
      case "+": return runAction("zoom-in");
      case "i": return runAction("mode-browser");
      case ":": return runAction("mode-input");
      case "/": return runAction("mode-search");
      case "Escape": return (switchVisualMode("command"), runAction("send-escape"), runAction(state.loading ? "cancel-load" : "search-stop"));
      case "Enter": return clickPointer();
    }
  }

  function onBrowserSearchengines () {
    setState(state => ({ ...state, searchengines: Setting.searchengines }));
  }

  function onChange (e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;

    switch (mode) {
      case "input": return setState(state => ({ ...state, input: value }));
      case "search": return setState(state => ({ ...state, search: value }));
    }
  }

  function onSubmit (e: React.FormEvent) {
    e.stopPropagation();
    e.preventDefault();

    if (!webview.current) return;

    runAction("mode-command");

    switch (mode) {
      case "input":
        if (state.input) {
          const url = webview.current.getURL();

          setState(state => ({ ...state, input: url === "about:blank" ? "" : url }));
          webview.current.src = getUrl(state.input);
        }
        break;
      case "search":
        if (state.search) {
          runAction("search-forward");
        }
        break;
    }
  }

  function onLoad () {
    if (webview.current) {
      const url = webview.current.getURL();
      const input = url === "about:blank" ? "" : url;
      const title = webview.current.getTitle();
      const loading = webview.current.isLoadingMainFrame();

      setState(state => {
        state.input === "" && webview.current?.clearHistory();
        const mode = getMode(document.activeElement);

        !["blur", "command", "visual"].includes(mode) && state.loading !== loading && runAction("mode-command");

        return { ...state, input: mode === "input" ? state.input : input, title, loading };
      });
    }
  }

  function onFavicon (e: Electron.PageFaviconUpdatedEvent) {
    if (webview.current) {
      setState(state => ({ ...state, favicon: e.favicons[0] }));
    }
  }

  function onBrowserAction (id: number, action: string) {
    webview.current?.getWebContentsId() === id && runAction(action);
  }

  function runAction(action: string) {
    if (webview.current) {
      if (webview.current.getURL() === "about:blank") return input.current?.focus();

      switch (action) {
        case "search-start": return webview.current.stopFindInPage("activateSelection");
        case "search-stop": return webview.current.stopFindInPage(state.search ? "keepSelection" : "clearSelection");
        case "search-backward": return webview.current.findInPage(state.search, { forward: false });
        case "search-forward": return webview.current.findInPage(state.search, { forward: true });
        case "navigate-backward": return webview.current.goBack();
        case "navigate-forward": return webview.current.goForward();
        case "reload": return webview.current.reloadIgnoringCache();
        case "zoom-out": return setZoom(state.zoom - 10);
        case "zoom-in": return setZoom(state.zoom + 10);
        case "devtool": return Emit.send(`browser:devtool:${webview.current.getWebContentsId()}`);
        case "mode-browser": return webview.current.focus();
        case "mode-input": return input.current?.focus();
        case "mode-search": return search.current?.focus();
        case "mode-command": return command.current?.focus();
        case "cancel-load": return webview.current.stop();
        case "send-escape": mode === "command" && webview.current.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      }
    }
  }

  function setZoom(zoom: number) {
    if (webview.current) {
      zoom = Math.min(Math.max(zoom , 0), 300);

      setState(state => ({ ...state, zoom }));
      webview.current.setZoomLevel((zoom / 100) - 1);
    }
  }

  function selectEngine(e: React.MouseEvent, name: string) {
    const selected = state.searchengines.find(engine => engine.name === name);

    if (webview.current && selected && selected.uri.indexOf("${query}") < 0) {
      if (e.ctrlKey || e.metaKey) {
        emit.send("browser:open", selected.uri);
      } else {
        webview.current.src = selected.uri;
      }
    } else {
      const searchengines = state.searchengines.map(engine => ({ ...engine, selected: selected === engine }));

      setState(state => ({ ...state, searchengines }));
      runAction("mode-input");
      Setting.searchengines = searchengines;
    }
  }

  function deleteEngine(name: string) {
    const selected = state.searchengines.find(engine => engine.name === name);

    Setting.searchengines = state.searchengines.filter(engine => selected !== engine);
    Emit.share("browser:searchengines");
  }

  const saveEngine = async () => {
    if (webview.current) {
      const uri = await emit.send<string>("neovim:readline", "URI", webview.current.getURL());
      const selected = state.searchengines.find(engine => engine.uri === uri);
      const name = uri && await emit.send<string>("neovim:readline", "Name", selected?.name || "");
      const hasquery = uri.indexOf("${query}") >= 0;

      if (uri && name) {
        Setting.searchengines = [
          ...state.searchengines.filter(engine => engine.name !== name && engine.uri !== uri).map(engine => ({ ...engine, selected: engine.selected && !hasquery })),
          { name, uri, selected: hasquery }
        ].sort((a, b) => a.name > b.name ? 1 : -1);

        Emit.share("browser:searchengines");
      }
    }

    runAction("mode-input");
  };

  function renderEngine(base: string) {
    const regexp = new RegExp(`^${base}`);
    const searchengines = state.searchengines.filter(({ name }) => name.match(regexp)).map(({ name, ...other }) => ({ ...other, name: name.replace(regexp, "") }));
    const groups = searchengines.map(({ name }) => name.split("/")).reduce((all, curr) => curr.length === 1 || all.indexOf(curr[0]) >= 0 ? all : [...all, curr[0]], []);
    const selected = state.searchengines.find(({ selected }) => selected);

    return (
      <>
        { groups.map(group =>
          <MenuComponent key={`${base}${group}`} color="lightblue-fg" label={`󰉋 ${group}`} active={selected?.name.indexOf(`${base}${group}/`) === 0} side>
            { renderEngine(`${base}${group}/`) }
          </MenuComponent>
        ) }
        { searchengines.filter(({ name }) => name.split("/").length === 1).map(({ name, selected }, i) =>
          <FlexComponent  key={`${base}-${i}`} animate="hover" active={selected} onClick={e => selectEngine(e, `${base}${name}`)} spacing>
            { name }
            <IconComponent color="gray" font={uiIcons.close} float="right" onClick={() => deleteEngine(`${base}${name}`)} hover />
          </FlexComponent>
        ) }
      </>
    );
  }

  return (
    <FocusProvider targets={[command, input, search, webview]} initial={blank ? input : command} delegate={props.active}>
      <FlexComponent animate="fade-in" direction="column" position="absolute" color="default" inset={[0]} style={props.style}>
        <input style={styles.command} type="text" ref={command} onChange={onChange} onKeyDown={onKeyDown} tabIndex={-1} />
        <FlexComponent color="gray-fg" vertical="center" horizontal="center">
          { state.loading
            ? <><div className="animate loading inline"></div><FlexComponent margin={[0, 4]} style={styles.title}>{ state.title }</FlexComponent></>
            : <IconComponent font={state.favicon || ""} text={state.title} style={styles.title} />
          }
        </FlexComponent>
        <FlexComponent vertical="center">
          <IconComponent font="" onClick={() => runAction("navigate-backward")} />
          <IconComponent font="" onClick={() => runAction("navigate-forward")} />
          <IconComponent font={ state.loading ? uiIcons.stop : uiIcons.refresh } onClick={() => runAction(state.loading ? "cancel-load" : "reload")} />
          <MenuComponent label={() => <IconComponent { ...icon } onClick={saveEngine} />}>
            { renderEngine("") }
          </MenuComponent>
          <FlexComponent grow={1} shrink={2} padding={[0, 8, 0, 0]}>
            <form style={styles.form} onSubmit={onSubmit}>
              <input style={styles.input} type="text" ref={input} value={state.input} onChange={onChange} tabIndex={-1} />
            </form>
          </FlexComponent>
          <IconComponent font={uiIcons.search} />
          <FlexComponent shrink={3}>
            <form style={styles.input} onSubmit={onSubmit}>
              <input style={styles.input} type="text" ref={search} value={state.search} onChange={onChange} tabIndex={-1} />
            </form>
          </FlexComponent>
          <IconComponent font="" onClick={() => runAction("zoom-out")} />
          { state.zoom }%
          <IconComponent font="" onClick={() => runAction("zoom-in")} />
          <IconComponent font="󱁤" onClick={() => runAction("devtool")} />
          {webPage && (
            <IconComponent font={agentIcon || uiIcons.acp} mark={!!agentIcon} color={shared ? "purple-fg" : "gray-fg"} style={shareIconStyle}
              onClick={canToggleSharing ? () => webview.current && void emit.send("browser:share:toggle", webview.current.getWebContentsId(), !shared) : undefined} />
          )}
          {(mock || webPage) && (
            <IconComponent font={uiIcons.placing} color={selecting ? "purple-fg" : "gray-fg"} onClick={canToggleSelection ? selectElement : undefined} />
          )}
        </FlexComponent>
        <FlexComponent color={color} margin={[2]} padding={[2]} border={[1]} rounded={[2]} grow={1} shadow>
          <div className="space" ref={container} />
          { renderRect() }
        </FlexComponent>
      </FlexComponent>
    </FocusProvider>
  );
}
