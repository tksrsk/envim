import React, { useEffect, useState, useRef, RefObject, MouseEvent, DragEvent, WheelEvent } from "react";

import { ICell, IScroll, IBuffer } from "common/interface";

import { useEditor } from "../../context/editor";

import { Emit } from "../../utils/emit";
import { Setting } from "../../utils/setting";
import { Canvas } from "../../utils/canvas";
import { y2Row, x2Col } from "../../utils/size";

import { FlexComponent } from "../flex";
import { IconComponent } from "../icon";
import { MenuComponent } from "../menu";
import { WebviewComponent } from "../webview";

interface Props {
  id: string;
  gid: number;
  winid: number;
  focusable: boolean;
  focus: boolean;
  shadow: boolean
  type: "normal" | "floating" | "external";
  style: {
    zIndex: number;
    width: number;
    height: number;
    transform: string;
    visibility: "visible" | "hidden";
  };
}

interface States {
  bufs: IBuffer[];
  nomouse: boolean;
  dragging: boolean;
  hidden: boolean;
  scrolling: number;
  preview: { src: string; active: boolean; };
  scroll: {
    total: number;
    height: string;
    transform: string;
  };
}

export function EditorComponent(props: Props) {
  const { busy, options, mode, bufs, drag } = useEditor();
  const [state, setState] = useState<States>({ bufs, nomouse: drag !== "" && drag !== props.id, dragging: false, hidden: false, scrolling: 0, preview: { src: "", active: false }, scroll: { total: 0, height: "100%", transform: "" } });
  const canvas: RefObject<HTMLCanvasElement | null> = useRef<HTMLCanvasElement>(null);
  const timer: RefObject<number> = useRef(0);
  const pointer: RefObject<{ row: number; col: number }> = useRef({ row: 0, col: 0 });
  const dragging: RefObject<{ x: number; y: number }> = useRef({ x: 0, y: 0 });
  const delta: RefObject<{ x: number; y: number }> = useRef({ x: 0, y: 0 });
  const { height, scale } = Setting.font;

  useEffect(() => {
    Emit.on(`clear:${props.id}`, onClear);
    Emit.on(`flush:${props.id}`, onFlush);
    Emit.on(`preview:${props.id}`, onPreview);
    Emit.on(`viewport:${props.id}`, onViewport);

    return () => {
      clearInterval(timer.current);
      Canvas.delete(props.id);
      Emit.off(`clear:${props.id}`, onClear);
      Emit.off(`flush:${props.id}`, onFlush);
      Emit.off(`preview:${props.id}`, onPreview);
      Emit.off(`viewport:${props.id}`, onViewport);
    };
  }, [])

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");

    if (canvas.current && ctx) {
      Canvas.create(props.id, canvas.current, ctx, props.type === "normal");
      Emit.send("envim:ready", props.gid);
    }
  }, []);

  useEffect(() => {
      Canvas.update(props.id, props.type === "normal");
      Emit.send("envim:resized", props.gid);
  }, [props.style.width, props.style.height]);

  useEffect(() => {
      props.focus && Emit.share("envim:focusable", !state.preview.active);
  }, [props.focus, state.preview.active]);

  function runCommand(e: MouseEvent, command: string) {
    e.stopPropagation();
    e.preventDefault();

    command && Emit.send("envim:api", "nvim_call_function", ["win_execute", [props.winid, command]]);
  }

  function onMouseEvent(e: MouseEvent, action: string, button: string = "") {
    button = button || ["left", "middle", "right"][e.button] || "left";

    const [col, row] = [ x2Col(e.nativeEvent.offsetX), y2Row(e.nativeEvent.offsetY) ];
    const modiffier = [];
    const skip = (button === "move" || action === "drag") && row === pointer.current.row && col === pointer.current.col;
    const gid = props.gid === 1 ? 0 : props.gid;
    const url = (action === "press" || button === "move") ? Canvas.link(props.id, row, col) : "";

    e.shiftKey && modiffier.push("S");
    e.ctrlKey && modiffier.push("C");
    e.altKey && modiffier.push("A");

    pointer.current = { row, col };

    if (url && action === "press") {
      url.search(/^https?:\/\//) < 0 ? runCommand(e, `edit ${url}`) : Emit.send("envim:browser", url);
    }
    if (!skip && button === "move") {
      (e.currentTarget as HTMLElement).style.cursor = url ? "pointer" : "";
    }

    skip || Emit.send("envim:mouse", gid, button, action, modiffier.join("-"), row, col);
  }

  function onMouseDown(e: MouseEvent) {
    clearTimeout(timer.current);

    timer.current = +setTimeout(() => {
      Emit.share("envim:drag", props.id);
    });

    onMouseEvent(e, "press");
  }

  function onMouseMove(e: MouseEvent) {
    if (!(drag || options.mousemoveevent) || busy || mode?.short_name === "i") return;

    onMouseEvent(e, "drag", drag ? "" : "move");
  }

  function onMouseUp(e: MouseEvent) {
    clearTimeout(timer.current);

    if (drag) {
      Emit.share("envim:drag", "");
    }
    onMouseEvent(e, "release");
  }

  function onDragStart(e: DragEvent) {
    dragging.current = { x: e.clientX, y: e.clientY };
  }

  function onDragEnd(e: DragEvent) {
    const match = props.style.transform.match(/^translate\((\d+)px, (\d+)px\)$/);

    if (match) {
      const offset = { x: +match[1] + e.clientX - dragging.current.x, y: +match[2] + e.clientY - dragging.current.y };
      const resize = {
        width: props.style.width + Math.min(0, offset.x),
        height: props.style.height + Math.min(0, offset.y),
      };

      dragging.current = { x: 0, y: 0 };
      setState(state => ({ ...state, dragging: false }));

      Emit.share("envim:drag", "");
      Emit.send("envim:position", props.gid, x2Col(Math.max(0, offset.x)), y2Row(Math.max(0, offset.y)));
      Emit.send("envim:resize", props.gid, Math.max(x2Col(resize.width), 18), y2Row(resize.height));
    }
  }

  function onWheel(e: WheelEvent) {
    delta.current.x = delta.current.x * e.deltaX >= 0 ? delta.current.x + e.deltaX : 0;
    delta.current.y = delta.current.y * e.deltaY >= 0 ? delta.current.y + e.deltaY : 0;

    const direction = Math.abs(delta.current.x) < Math.abs(delta.current.y) ? "y" : "x";
    const limit = Math.abs(direction === "x" ? x2Col(delta.current.x) : y2Row(delta.current.y));
    const action = {x: e.deltaX < 0 ? "left" : "right", y: e.deltaY < 0 ? "up" : "down"}[direction];

    for (let i = 0; i < limit; i++) {
      delta.current = { x: 0, y: 0 };
      onMouseEvent(e, action, "wheel");
    }
  }

  function onScroll(e: MouseEvent) {
    const per = e.nativeEvent.offsetY / e.currentTarget.clientHeight;
    const line = Math.ceil(state.scroll.total * per);

    runCommand(e, `${line} | redraw`);
  }

  function onClear() {
    Canvas.clear(props.id, x2Col(props.style.width), y2Row(props.style.height));
  }

  function onFlush(flush: { cells: ICell[], scroll?: IScroll }[]) {
    flush.forEach(({ cells, scroll }) => Canvas.push(props.id, cells, scroll));
  }

  function onPreview(src: string, active: boolean) {
    setState(state => ({ ...state, preview: { src, active } }));
  }

  function openExtWindow(e: MouseEvent) {
    const width = x2Col(props.style.width);
    const height = y2Row(props.style.height);

    runCommand(e, `call nvim_win_set_config(0, { "width": ${width}, "height": ${height}, "external": 1 })`)
  }

  function dragExtWIndow(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    setState(state => ({ ...state, dragging: true }));
    Emit.share("envim:drag", props.id);
  }

  function toggleExtWindow(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    setState(state => ({ ...state, hidden: !state.hidden }));
  }

  function onViewport(top: number, bottom: number, total: number) {
    setState(state => {
      const limit = props.style.height;
      const height = Math.min(Math.floor((bottom - top) / total * 100), 100);
      const scrolling = height === 100 ? 0 : +setTimeout(() => setState(state => ({ ...state, scrolling: 0 })) , 500);

      state.scroll && clearTimeout(state.scrolling);

      return { ...state, scrolling, scroll: {
        total,
        height: height ? `${height}%` : "4px",
        transform: `translateY(${Math.min(Math.floor(top / total * limit), limit - 4)}px)`,
      }};
    });
  }

  useEffect(() => {
    const nomouse = ["", props.id].indexOf(drag) < 0;

    setState(state => ({ ...state, nomouse, dragging: drag === "" ? false : state.dragging }));
  }, [drag === "" || drag === props.id]);

  useEffect(() => {
    setState(state => ({ ...state, bufs }));
  }, [bufs]);

  function renderMenu(label: string, command: string) {
    return (
      <MenuComponent color="gray-fg" label={label}>
        { state.bufs.map(({ name, buffer, active }, i) => (
          <FlexComponent active={active} title={name} onClick={e => runCommand(e, `${command}${buffer}`)} key={i} spacing>
            { name.replace(/.*\//, "…/") }
          </FlexComponent>
        )) }
      </MenuComponent>
    );
  }

  function renderIconMenu(label: string, menus: { font: string, onClick: (e: MouseEvent) => void }[][]) {
    return (
      <MenuComponent color="gray-fg" label={label} fit>
        { menus.map((menu, i) => (
          <FlexComponent key={i}>
            { menu.map((item, j) => <IconComponent key={`${i}-${j}`} color="gray-fg" { ...item } />) }
          </FlexComponent>
        )) }
      </MenuComponent>
    );
  }

  function renderPreview() {
    const { src, active } = state.preview;
    return active && <WebviewComponent src={src} active={props.focus} style={!state.hidden ? {} : { display: "none" }} />;
  }

  return (
    <FlexComponent animate="fade-in hover" position="absolute" overflow="visible" nomouse={state.nomouse} style={{ ...props.style, ...(state.hidden ? { height: 0 } : {}) }} shadow={props.shadow && !state.hidden}
      onMouseDown={state.dragging ? undefined : onMouseDown}
      onMouseMove={state.dragging ? undefined : onMouseMove}
      onMouseUp={state.dragging ? undefined : onMouseUp}
      onWheel={state.dragging ? undefined : onWheel}
      onDragStart={state.dragging ? onDragStart : undefined}
      onDragEnd={state.dragging ? onDragEnd : undefined}
    >
      <FlexComponent nomouse>
        <canvas width={props.style.width * scale} height={props.style.height * scale} ref={canvas} />
      </FlexComponent>
      { props.gid === 1 || renderPreview() }
      { props.gid === 1 || !props.focusable ? null : (
        <>
          <FlexComponent color="default" grow={1} position="absolute" inset={[0, -4, 0, "auto"]} onMouseDown={onScroll} hover={state.scrolling === 0}>
            <FlexComponent animate="fade-in" color="blue" border={[0, 2]} rounded={[2]} style={state.scroll} shadow nomouse></FlexComponent>
          </FlexComponent>
          <FlexComponent color={state.hidden ? "orange" : "default"} position="absolute" overflow="visible" inset={[-height, -4, "auto", "auto"]} rounded={state.hidden ? [4] : [4, 4, 0, 0]} hover={!state.hidden} spacing
            onMouseDown={e => runCommand(e, "")}
          >
            { props.type === "normal" && renderMenu("", "buffer ") }
            { props.type === "normal" && renderIconMenu("", [
              [
                { font: "", onClick: e => runCommand(e, "enew") },
                { font: "", onClick: e => runCommand(e, "vsplit") },
                { font: "", onClick: e => runCommand(e, "split") },
              ],
              [
                { font: "󰶭", onClick: openExtWindow },
                { font: "󱂪", onClick: e => runCommand(e, "wincmd H") },
                { font: "󱂫", onClick: e => runCommand(e, "wincmd L") },
              ],
              [
                { font: "󱔓", onClick: e => runCommand(e, "wincmd K") },
                { font: "󱂩", onClick: e => runCommand(e, "wincmd J") },
                { font: "󰉡", onClick: e => runCommand(e, "wincmd =") },
              ],
            ]) }
            { !state.preview.active && props.type === "normal" && <IconComponent color="gray-fg" font="" onClick={e => runCommand(e, "write")} /> }
            { props.type === "external" && <IconComponent color="gray-fg" font={state.hidden ? "" : ""} onClick={toggleExtWindow} /> }
            { props.type === "external" && !state.hidden && (
              <>
                <IconComponent color="gray-fg" font="󰮐" active={state.dragging} onClick={dragExtWIndow} />
                { renderIconMenu("", [
                  [
                    { font: "󱂪", onClick: e => runCommand(e, "wincmd H") },
                    { font: "󱂫", onClick: e => runCommand(e, "wincmd L") },
                  ],
                  [
                    { font: "󱔓", onClick: e => runCommand(e, "wincmd K") },
                    { font: "󱂩", onClick: e => runCommand(e, "wincmd J") },
                  ],
                ]) }
              </>
            ) }
            <IconComponent color="gray-fg" font="" onClick={e => runCommand(e, "confirm quit")} />
          </FlexComponent>
        </>
      )}
    </FlexComponent>
  );
}
