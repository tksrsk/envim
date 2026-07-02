import React from "react";

import { ISetting, IMessage } from "common/interface";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";

import { Emit } from "renderer/utils/emit";

import { FlexComponent } from "renderer/components/flex";
import { MenuComponent } from "renderer/components/menu";
import { IconComponent } from "renderer/components/icon";
import { MessageComponent } from "renderer/components/envim/message";

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

const styles: { [k: string]: React.CSSProperties } = {
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
  const { emit } = useWorkspace();
  const [ state, setState ] = React.useState<States>({ messages: [], theme: "dark", options, debug: "" });
  const bottom: React.RefObject<HTMLDivElement | null> = React.useRef<HTMLDivElement>(null);
  const timer: React.RefObject<number> = React.useRef<number>(0);

  React.useEffect(() => {
    emit.on("messages:mode", onMode);
    emit.on("messages:command", onCommand);
    emit.on("messages:ruler", onRuler);
    emit.on("messages:history", onHistory);

    return () => {
      emit.off("messages:mode", onMode);
      emit.off("messages:command", onCommand);
      emit.off("messages:ruler", onRuler);
      emit.off("messages:history", onHistory);
    };
  }, []);

  React.useEffect(() => {
    state.debug && Emit.on("debug", onDebug);

    return () => {
      Emit.off("debug", onDebug);
    };
  }, [state.debug]);

  React.useEffect(() => {
    state.messages.length && bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

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
    setState(state => ({ ...state, messages: [ ...state.messages, ...messages ].slice(-1000) }));
  }

  React.useEffect(() => {
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
    timer.current = +setInterval(() => emit.send("envim:command", "messages"), 500);
  }

  function unloadMessages() {
    clearInterval(timer.current);
  }

  function toggleTheme() {
    setState(state => {
      const theme = state.theme === "dark" ? "light" : "dark";

      emit.send("envim:command", `set background=${theme}`);

      return { ...state, theme };
    });
  }

  async function toggleDebug() {
    const debug = await emit.send<string>("envim:readline", "Event name");

    try {
      "".search(debug);
      setState(state => ({ ...state, debug }));
    } catch (e: any) {
      if (e instanceof Error) {
        const contents = [{ hl: "color-red", content: e.message }];
        emit.share("messages:show", [{ kind: "debug", contents }], true);
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
            <FlexComponent key={ext} onClick={() => emit.send("envim:option", ext, !state.options[ext])} spacing>
              <input type="checkbox" value="command" checked={state.options[ext]} />{ ext }
            </FlexComponent>
          )) }
          <FlexComponent animate="hover" color="default" horizontal="center" onClick={toggleTheme}>
            <IconComponent color="orange-fg" active={state.theme === "light"} font="" />
            /
            <IconComponent color="yellow-fg" active={state.theme === "dark"} font="" />
          </FlexComponent>
        </MenuComponent>
        { state.options.ext_multigrid && <IconComponent color="lightblue-fg" font="󰖟" onClick={() => emit.send("envim:browser", "", "tabnew")} /> }
        <IconComponent color="purple-fg" font="" onClick={() => emit.send("acp:toggle")} />
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
