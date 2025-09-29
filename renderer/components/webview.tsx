import { WebviewTag, PageFaviconUpdatedEvent } from "electron";
import React, { useEffect, useState, useRef, RefObject, MouseEvent, FormEvent, ChangeEvent, KeyboardEvent } from "react";

import { ISetting } from "../../common/interface";

import { Emit } from "../utils/emit";
import { Setting } from "../utils/setting";

import { FlexComponent } from "./flex";
import { MenuComponent } from "./menu";
import { IconComponent } from "./icon";

interface Props {
  src: string;
  active: boolean;
  style: { [k: string]: string };
}

interface States {
  input: string;
  search: string;
  title: string;
  loading: boolean;
  favicon?: string;
  mode: "command" | "input" | "search" | "browser" | "blur";
  searchengines: ISetting["searchengines"];
  zoom: number;
}

const position: "absolute" = "absolute";
const styles = {
  command: {
    position,
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
};

export function WebviewComponent(props: Props) {
  const [state, setState] = useState<States>({ input: props.src, search: "", title: "", loading: false, mode: "blur", searchengines: Setting.searchengines, zoom: 100 });
  const container: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);
  const webview: RefObject<WebviewTag | null> = useRef<WebviewTag>(null);
  const input: RefObject<HTMLInputElement | null> = useRef<HTMLInputElement>(null);
  const search: RefObject<HTMLInputElement | null> = useRef<HTMLInputElement>(null);
  const command: RefObject<HTMLInputElement | null> = useRef<HTMLInputElement>(null);
  const icon = state.searchengines.some(({ uri }) => uri === state.input)
    ? { color: "blue-fg", font: "" }
    : { color: "gray-fg", font: "" };
  const preview = props.src.search(/^file:\/\/.*[\/\\]Envim[\/\\]tmp.\w+$/) === 0;
  const color = { command: "green", input: "default", search: "default", browser: "blue", blur: "default" }[state.mode];

  useEffect(() => {
    Emit.on("envim:focused", onFocused);
    Emit.on("webview:action", onAction);
    Emit.on("webview:searchengines", onSearchengines);

    return () => {
      Emit.off("envim:focused", onFocused);
      Emit.off("webview:action", onAction);
      Emit.off("webview:searchengines", onSearchengines);
    };
  }, []);

  useEffect(() => {
    if (container.current && !container.current.innerHTML) {
      container.current.innerHTML = `<webview allowpopups="on" />`;
    }
    if (container.current) {
      const webview = container.current.querySelector("webview") as WebviewTag;

      webview.addEventListener("dom-ready", onReady);
      webview.src = getUrl(props.src);

      return () => {
        webview.removeEventListener("did-start-loading", onLoad);
        webview.removeEventListener("did-stop-loading", onLoad);
        webview.removeEventListener("did-finish-load", onLoad);
        webview.removeEventListener("did-navigate", onLoad);
        webview.removeEventListener("did-navigate-in-page", onLoad);
        webview.removeEventListener("page-title-updated", onLoad);
        webview.removeEventListener("page-favicon-updated", onFavicon);
        webview.removeEventListener("focus", onFocus);
      };
    }
  }, [container.current === undefined, props.src]);

  useEffect(() => {
    props.active && runAction("mode-command");
  }, [props.active]);

  function onReady () {
    if (container.current) {
      webview.current = container.current.querySelector("webview") as WebviewTag;
      webview.current.removeEventListener("dom-ready", onReady);
      webview.current.addEventListener("did-start-loading", onLoad);
      webview.current.addEventListener("did-stop-loading", onLoad);
      webview.current.addEventListener("did-finish-load", onLoad);
      webview.current.addEventListener("did-navigate", onLoad);
      webview.current.addEventListener("did-navigate-in-page", onLoad);
      webview.current.addEventListener("page-title-updated", onLoad);
      webview.current.addEventListener("page-favicon-updated", onFavicon);
      webview.current.addEventListener("focus", onFocus);
      webview.current.addEventListener("close", onClose);
      props.active && runAction("mode-command");
    }
  }

  function getUrl(input: string) {
    input = input.trim();

    if (!input || input === "about:blank") {
      return "about:blank";
    } else if (input.search(/^(((https?)|(file)):\/\/)|(data:.*\/.*;base64)/) === 0) {
      return input;
    } else {
      const selected = state.searchengines.find(({ selected }) => selected);

      return selected?.uri.replace("${query}", encodeURIComponent(input)) || "about:blank";
    }
  }

  function onCancel (e: MouseEvent) {
    e.stopPropagation();

    e.type !== "mousemove" && state.mode === "blur" && runAction("mode-command");
  }

  function onFocus () {
    Emit.share("envim:focused");
  }

  function onClose() {
    webview.current = null;
  }

  function onFocused () {
    setState(state => {
      const mode = (() => {
        switch (document.activeElement) {
          case command.current: return "command";
          case input.current: return "input";
          case search.current: return "search";
          case webview.current: return "browser";
          default: return "blur";
        }
      })();

      state.mode !== mode && ["input", "search"].includes(mode) && (document.activeElement as HTMLInputElement).select();

      return { ...state, mode };
    });
  }

  function onKeyDown (e: KeyboardEvent) {
    const modkey = e.ctrlKey || e.metaKey;

    e.stopPropagation();
    e.preventDefault();

    if (!webview.current) return;

    switch (modkey && e.key) {
      case "r": return runAction("reload");
      case "i": return runAction("devtool");
      case "u": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "PageUp" });
      case "d": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "PageDown" });
      case "s": return Emit.send("envim:command", "new envim://browser");
      case "v": return Emit.send("envim:command", "vnew envim://browser");
      case "t": return Emit.send("envim:command", "tabnew envim://browser");
    }

    switch (e.key) {
      case "h": return runAction("navigate-backward");
      case "j": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "Down" })
      case "k": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "Up" })
      case "l": return runAction("navigate-forward");
      case "N": return runAction("search-backward");
      case "n": return runAction("search-forward");
      case "g": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "Home" });
      case "G": return webview.current.sendInputEvent({ type: "keyDown", keyCode: "End" });
      case "Y": return Emit.send(`capture:${webview.current.getWebContentsId()}`);
      case "-": return runAction("zoom-out");
      case "+": return runAction("zoom-in");
      case "i": return runAction("mode-browser");
      case ":": return runAction("mode-input");
      case "/": return runAction("mode-search");
      case "Escape": return runAction(state.loading ? "cancel-load" : "mode-command");
      case "Enter": return webview.current.stopFindInPage("activateSelection");
    }
  }

  function onSearchengines () {
    setState(state => ({ ...state, searchengines: Setting.searchengines }));
  }

  function onChange (e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;

    switch (state.mode) {
      case "input": return setState(state => ({ ...state, input: value }));
      case "search": return setState(state => ({ ...state, search: value }));
    }
  }

  function onSubmit (e: FormEvent) {
    e.stopPropagation();
    e.preventDefault();

    if (!webview.current) return;

    runAction("mode-command");

    switch (state.mode) {
      case "input":
        if (state.input) {
          webview.current.src = getUrl(state.input);
        }
        setState(state => ({ ...state, input: "" }));
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
        !["blur", "command"].includes(state.mode) && state.loading !== loading && runAction("mode-command");

        return { ...state, input: state.mode === "input" ? state.input : input, title, loading };
      });
    }
  }

  function onFavicon (e: PageFaviconUpdatedEvent) {
    if (webview.current) {
      setState(state => ({ ...state, favicon: e.favicons[0] }));
    }
  }

  function onAction (id: number, action: string) {
    webview.current?.getWebContentsId() === id && runAction(action);
  }

  function runAction(action: string) {
    if (webview.current) {
      if (webview.current.getURL() === "about:blank") return input.current?.focus();

      switch (action) {
        case "search-backward": return state.search && webview.current.findInPage(state.search, { forward: false });
        case "search-forward": return state.search && webview.current.findInPage(state.search, { forward: true });
        case "navigate-backward": return webview.current.goBack();
        case "navigate-forward": return webview.current.goForward();
        case "reload": return webview.current.reloadIgnoringCache();
        case "zoom-out": return setZoom(state.zoom - 10)
        case "zoom-in": return setZoom(state.zoom + 10)
        case "devtool": return Emit.send(`devtool:${webview.current.getWebContentsId()}`);
        case "mode-browser": return webview.current.focus();
        case "mode-input": return input.current?.focus();
        case "mode-search": return search.current?.focus();
        case "mode-command": return command.current?.focus();
        case "cancel-load": return webview.current.stop();
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

  function selectEngine(e: MouseEvent, name: string) {
    const selected = state.searchengines.find(engine => engine.name === name);

    if (webview.current && selected && selected.uri.indexOf("${query}") < 0) {
      if (e.ctrlKey || e.metaKey) {
        Emit.send("envim:browser", selected.uri);
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
    Emit.share("webview:searchengines");
  }

  const saveEngine = async () => {
    if (webview.current) {
      const uri = await Emit.send<string>("envim:readline", "URI", webview.current.getURL());
      const selected = state.searchengines.find(engine => engine.uri === uri);
      const name = uri && await Emit.send<string>("envim:readline", "Name", selected?.name || "");
      const hasquery = uri.indexOf("${query}") >= 0;

      if (uri && name) {
        Setting.searchengines = [
          ...state.searchengines.filter(engine => engine.name !== name && engine.uri !== uri).map(engine => ({ ...engine, selected: engine.selected && !hasquery })),
          { name, uri, selected: hasquery }
        ].sort((a, b) => a.name > b.name ? 1 : -1);

        Emit.share("webview:searchengines");
      }
    }

    runAction("mode-input");
  }

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
            <IconComponent color="gray" font="" float="right" onClick={() => deleteEngine(`${base}${name}`)} hover />
          </FlexComponent>
        ) }
      </>
    );
  }

  return (
    <FlexComponent animate="fade-in" direction="column" position="absolute" color="default" overflow="visible" inset={[0]} style={props.style} onMouseDown={onCancel} onMouseMove={onCancel} onMouseUp={onCancel}>
      <input style={styles.command} type="text" ref={command} onChange={onChange} onFocus={onFocus} onKeyDown={preview ? undefined : onKeyDown} tabIndex={-1} />
      <FlexComponent color="gray-fg" vertical="center" horizontal="center">
        { state.loading
          ? <><div className="animate loading inline"></div><FlexComponent margin={[0, 4]}>{ state.title }</FlexComponent></>
          : <IconComponent font={state.favicon || ""} text={state.title} />
        }
      </FlexComponent>
      <FlexComponent vertical="center" overflow="visible" nomouse={preview}>
        <IconComponent font="" onClick={() => runAction("navigate-backward")} />
        <IconComponent font="" onClick={() => runAction("navigate-forward")} />
        <IconComponent font={ state.loading ? "" : "󰑓" } onClick={() => runAction(state.loading ? "cancel-load" : "reload")} />
        <MenuComponent color="blue-fg" label="󰖟">
          { renderEngine("") }
        </MenuComponent>
        <IconComponent { ...icon } onClick={saveEngine} />
        <FlexComponent grow={1} shrink={2} padding={[0, 8, 0, 0]}>
          <form style={styles.form} onSubmit={onSubmit}>
            <input style={styles.input} type="text" ref={input} value={state.input} onChange={onChange} onFocus={onFocus} disabled={preview} tabIndex={-1} />
          </form>
        </FlexComponent>
        <IconComponent font="" />
        <FlexComponent shrink={3}>
          <form style={styles.input} onSubmit={onSubmit}>
            <input style={styles.input} type="text" ref={search} value={state.search} onChange={onChange} onFocus={onFocus} disabled={preview} tabIndex={-1} />
          </form>
        </FlexComponent>
        <IconComponent font="" onClick={() => runAction("zoom-out")} />
        { state.zoom }%
        <IconComponent font="" onClick={() => runAction("zoom-in")} />
        <IconComponent font="󱁤" onClick={() => runAction("devtool")} />
      </FlexComponent>
      <FlexComponent color={color} margin={[2]} padding={[2]} border={[1]} rounded={[2]} grow={1} shadow>
        <div className="space" ref={container} />
      </FlexComponent>
    </FlexComponent>
  )
}
