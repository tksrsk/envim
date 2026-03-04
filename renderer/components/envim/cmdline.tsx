import React, { useEffect, useState } from "react";

import { useEditor } from "../../context/editor";

import { Emit } from "../../utils/emit";
import { Highlights } from "../../utils/highlight";
import { Setting } from "../../utils/setting";

import { FlexComponent } from "../flex";

interface States {
  cmdline: { hl: string, c: string }[];
  contents: { hl: string, c: string }[][];
  pos: number;
  prompt: string;
  indent: number;
  enabled: boolean;
}

const styles = {
  scope: {
    left: "10%",
    right: "10%",
  },
};

export function CmdlineComponent() {
  const { options } = useEditor();
  const [state, setState] = useState<States>({ cmdline: [], contents: [], pos: 0, prompt: "", indent: 0, enabled: options.ext_cmdline });

  useEffect(() => {
    Emit.on("cmdline:show", onCmdline);
    Emit.on("cmdline:cursor", onCursor);
    Emit.on("cmdline:special", onSpecial);
    Emit.on("cmdline:blockshow", onBlock);
    Emit.on("cmdline:blockhide", offBlock);

    return () => {
      Emit.off("cmdline:show", onCmdline);
      Emit.off("cmdline:cursor", onCursor);
      Emit.off("cmdline:special", onSpecial);
      Emit.off("cmdline:blockshow", onBlock);
      Emit.off("cmdline:blockhide", offBlock);
    };
  }, []);

  function getPos(cmdline: States["cmdline"], pos: number) {
    let result = 0;
    for (; pos >= 0; result++) {
      pos -= encodeURIComponent(cmdline[result]?.c || " ").replace(/%../g, "x").length;
    }
    return result - 1;
  }

  function convertContent(content: string[][], indent: number) {
    let result: States["cmdline"] = [];
    let i = 0;

    for (; i < indent; i++) {
      result.push({ hl: "0", c: " " });
    }
    content.forEach(([hl, text]) => {
      result = result.concat(text.split("").map(c => ({ hl, c })));
    });
    content.length && result.push({ hl: "0", c: " " });

    return result;
  }

  function onCmdline(cmd: string[][], pos: number, prompt: string, indent: number) {
    setState(state => {
      const cmdline = convertContent(cmd, indent);

      if (cmdline.length) {
        pos = getPos(cmdline, pos + indent);
      }

      return { ...state, cmdline, pos, prompt, indent };
    });
  }

  function onCursor(pos: number) {
    setState(state => {
      if (pos < state.cmdline.length) {
        pos = getPos(state.cmdline, pos + state.indent);
      }
      return { ...state, pos };
    });
  }

  function onSpecial(c: string, shift: boolean) {
    setState(state => {
      const cmdline = state.cmdline;
      const pos = shift ? state.pos + 1 : state.pos;

      cmdline.splice(state.pos, 0, { hl: "0", c });

      return { ...state, cmdline, pos };
    });
  }

  function onBlock(lines: string[][][]) {
    setState(state => ({
      ...state,
      contents: [
        ...state.contents,
        ...lines.map(line => convertContent(line, 0)),
      ]
    }));
  }

  function offBlock() {
    setState(state => ({ ...state, contents: [], cmdline: [] }));
  }

  useEffect(() => {
    options.ext_cmdline === undefined || setState(state => ({ ...state, enabled: options.ext_cmdline }));
  }, [options.ext_cmdline]);

  function getScopeStyle() {
    const { height } = Setting.font;
    return { padding: height, ...Highlights.style("0"), ...styles.scope };
  }

  function renderCmdline(cmdline: States["cmdline"], cursor: boolean) {
    return cmdline.map(({hl, c}, i) => {
      const reverse = cursor && i === state.pos;
      c = c.charCodeAt(0) < 0x20 ? `^${String.fromCharCode(c.charCodeAt(0) + 0x40)}` : c;
      return (hl || reverse) ? <div className="inline-block" style={Highlights.style(hl, { reverse })} key={i}>{ c }</div> : c;
    });
  }

  return state.enabled && state.cmdline.length > 0 && (
    <FlexComponent animate="slide-down" position="absolute" whiteSpace="pre-wrap" rounded={[0, 0, 4, 4]} style={getScopeStyle()} shadow nomouse>
      <FlexComponent whiteSpace="pre-wrap" shrink={0}><div className="bold">{ state.prompt }</div></FlexComponent>
      <div>
        {state.contents.map((content, i) => <div key={i}>{ renderCmdline(content, false) }</div>)}
        <div>{ renderCmdline(state.cmdline, true) }</div>
      </div>
    </FlexComponent>
  );
}
