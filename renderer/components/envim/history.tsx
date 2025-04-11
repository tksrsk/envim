import React, { useEffect, useState, useRef, RefObject } from "react";

import { ISetting, IMessage } from "../../../common/interface";

import { useEditor } from "../../context/editor";

import { Emit } from "../../utils/emit";

import { FlexComponent } from "../flex";
import { MenuComponent } from "../menu";
import { IconComponent } from "../icon";
import { MessageComponent } from "./message";

interface Props {
  width: number;
  height: number;
}

interface States {
  messages: IMessage[];
  theme: "dark" | "light";
  mode?: IMessage;
  command?: IMessage;
  ruler?: IMessage;
  options: ISetting["options"];
  debug: string;
}

const styles = {
  scope: {
    bottom: 0,
  },
  history: {
    maxHeight: 200,
    width: "100%",
    bottom: 0,
  },
};

export function HistoryComponent(props: Props) {
  const { options } = useEditor();
  const [ state, setState ] = useState<States>({ messages: [], theme: "dark", options, debug: "" });
  const bottom: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);
  const timer: RefObject<number> = useRef<number>(0);

  useEffect(() => {
    Emit.on("messages:mode", onMode);
    Emit.on("messages:command", onCommand);
    Emit.on("messages:ruler", onRuler);
    Emit.on("messages:history", onHistory);

    return () => {
      Emit.off("messages:mode", onMode);
      Emit.off("messages:command", onCommand);
      Emit.off("messages:ruler", onRuler);
      Emit.off("messages:history", onHistory);
    };
  }, []);

  useEffect(() => {
    state.debug && Emit.on("debug", onDebug);

    return () => {
      Emit.off("debug", onDebug);
    };
  }, [state.debug]);

  function onMode(message: IMessage) {
    setState(state => ({ ...state, mode: message.contents.length ? message : undefined }));
  }

  function onCommand(message: IMessage) {
    setState(state => ({ ...state, command: message.contents.length ? message : undefined }));
  }

  function onRuler(message: IMessage) {
    setState(state => ({ ...state, ruler: message.contents.length ? message : undefined }));
  }

  function onHistory(messages: IMessage[]) {
    setState(state => {
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }));
      messages = [ ...state.messages, ...messages ];

      return { ...state, messages: messages.slice(-1000) };
    })
  }

  useEffect(() => {
    setState(state => ({ ...state, options }));
  }, [options]);

  function onDebug(direction: "send" | "receive", event: string, ...args: any[]) {
    if (`${direction} ${event}`.search(state.debug) < 0) return;

    onHistory([{ contents: [
      direction === "send" ? { hl: "color-yellow", content: `[ 󰕒${event} ]` } : { hl: "color-blue", content: `[ 󰇚 ${event} ]` },
      { hl: "0", content: `\n${JSON.stringify(args, null, 2)}` }], kind: "debug" }
    ]);
  }

  function onClear() {
    setState(state => ({ ...state, messages: [] }));
  }

  function loadMessages() {
    clearInterval(timer.current);
    timer.current = +setInterval(() => Emit.send("envim:command", "messages"), 500);
  }

  function unloadMessages() {
    clearInterval(timer.current);
  }

  function toggleTheme() {
    setState(state => {
      const theme = state.theme === "dark" ? "light" : "dark";

      Emit.send("envim:command", `set background=${theme}`);

      return { ...state, theme };
    });
  }

  async function toggleDebug() {
    const debug = await Emit.send<string>("envim:readline", "Event name");

    try {
      "".search(debug);
      setState(state => ({ ...state, debug }));
    } catch (e: any) {
      if (e instanceof Error) {
        const contents = [{ hl: "color-red", content: e.message }];
        Emit.share("messages:show", [{ kind: "debug", contents }], true);
      }
    }
  }

  return (
    <FlexComponent animate="hover" direction="column-reverse" position="absolute" overflow="visible" style={styles.scope}>
      <FlexComponent color="default" overflow="visible" style={props}>
        { state.mode && <FlexComponent animate="fade-in" margin={["auto", 4]} rounded={[4]} shadow><MessageComponent message={state.mode} open /></FlexComponent> }
        { state.command && <FlexComponent animate="fade-in" margin={["auto", 4]} rounded={[4]} shadow><MessageComponent message={state.command} open /></FlexComponent> }
        { state.ruler && <FlexComponent animate="fade-in" margin={["auto", 4]} rounded={[4]} shadow><MessageComponent message={state.ruler} open /></FlexComponent> }
        <div className="space" />
        <MenuComponent color="gray-fg" label="">
          { ["ext_tabline", "ext_cmdline", "ext_messages", "ext_popupmenu", "ext_termcolors"].map(ext => (
            <FlexComponent key={ext} onClick={() => Emit.send("envim:option", ext, !state.options[ext])} spacing>
              <input type="checkbox" value="command" checked={state.options[ext]} />{ ext }
            </FlexComponent>
          )) }
          <FlexComponent animate="hover" color="default" horizontal="center" onClick={toggleTheme}>
            <IconComponent color="orange-fg" active={state.theme === "light"} font="" />
            /
            <IconComponent color="yellow-fg" active={state.theme === "dark"} font="" />
          </FlexComponent>
        </MenuComponent>
        { state.options.ext_multigrid && <IconComponent color="lightblue-fg" font="󰖟" onClick={() => Emit.send("envim:command", "tabnew envim://browser")} /> }
        <IconComponent color="green-fg" active={state.debug.length > 0} font="" onClick={toggleDebug} />
      </FlexComponent>
      <FlexComponent overflow="visible" hover>
        <FlexComponent direction="column" position="absolute" rounded={[4, 4, 0, 0]} overflow="auto" style={styles.history} shadow>
          { state.messages.map((message, i) => <div key={i}><MessageComponent message={message} open={message.kind !== "debug"} /></div>) }
          { state.options.ext_messages && (
            <FlexComponent color="default" onMouseEnter={loadMessages} onMouseLeave={unloadMessages}>
              <FlexComponent grow={1} />
              <IconComponent color="lightblue-fg" font="󰑓" text="Load more..." />
              <FlexComponent grow={1} />
              { state.messages.length === 0 ? null : <IconComponent color="red-fg" font="󰂭" onClick={onClear} /> }
            </FlexComponent>
          ) }
          <div ref={bottom} />
        </FlexComponent>
      </FlexComponent>
    </FlexComponent>
  );
}
