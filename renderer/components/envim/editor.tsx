import React from "react";

import { ICell, IScroll, IBuffer } from "common/interface";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";

import { Setting } from "renderer/utils/setting";
import { uiIcons } from "renderer/utils/icons";
import { y2Row, x2Col } from "renderer/utils/size";

import { ActionIcon, Menu } from "@mantine/core";
import { MenuComponent, SubMenuComponent, MenuItemComponent } from "renderer/components/menu";

interface Props {
  gid: number;
  revision: number;
  winid: number;
  focusable: boolean;
  focus: boolean;
  shadow: boolean;
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
}

const moves = [
  { font: "󱂪", label: "Move to left", command: "wincmd H" },
  { font: "󱂫", label: "Move to right", command: "wincmd L" },
  { font: "󱔓", label: "Move to top", command: "wincmd K" },
  { font: "󱂩", label: "Move to bottom", command: "wincmd J" },
];

export function EditorComponent(props: Props) {
  const { busy, options, mode, bufs, drag } = useEditor();
  const { emit, canvas: canvasApi } = useWorkspace();
  const [state, setState] = React.useState<States>({ bufs, nomouse: drag !== "" && drag !== props.gid, dragging: false, hidden: false });
  const canvas: React.RefObject<HTMLCanvasElement | null> = React.useRef<HTMLCanvasElement>(null);
  const timer: React.RefObject<number> = React.useRef(0);
  const pointer: React.RefObject<{ row: number; col: number }> = React.useRef({ row: 0, col: 0 });
  const dragging: React.RefObject<{ x: number; y: number }> = React.useRef({ x: 0, y: 0 });
  const delta: React.RefObject<{ x: number; y: number }> = React.useRef({ x: 0, y: 0 });
  const { scale } = Setting.font;

  React.useEffect(() => {
    emit.on(`neovim:ui:grid:clear:${props.gid}`, onNeovimUiGridClear);
    emit.on(`neovim:ui:grid:flush:${props.gid}`, onNeovimUiGridFlush);

    return () => {
      clearInterval(timer.current);
      canvasApi.delete(props.gid);
      emit.off(`neovim:ui:grid:clear:${props.gid}`, onNeovimUiGridClear);
      emit.off(`neovim:ui:grid:flush:${props.gid}`, onNeovimUiGridFlush);
    };
  }, []);

  React.useEffect(() => {
    if (canvas.current) {
      canvasApi.create(props.gid, canvas.current, props.type === "normal");
      emit.send("neovim:ui:ready", props.gid, props.revision);
    }
  }, []);

  React.useEffect(() => {
      canvasApi.update(props.gid, props.type === "normal");
      emit.send("neovim:ui:resized", props.gid, props.revision);
  }, [props.revision, props.style.width, props.style.height]);

  function runCommand(e: React.MouseEvent, command: string) {
    e.stopPropagation();
    e.preventDefault();

    command && emit.send("neovim:function", "win_execute", [props.winid, command]);
  }

  function onMouseEvent(e: React.MouseEvent, action: string, button: string = "") {
    button = button || ["left", "middle", "right"][e.button] || "left";

    const [col, row] = [ x2Col(e.nativeEvent.offsetX), y2Row(e.nativeEvent.offsetY) ];
    const modiffier: string[] = [];
    const skip = (button === "move" || action === "drag") && row === pointer.current.row && col === pointer.current.col;
    const gid = props.gid === 1 ? 0 : props.gid;
    const url = (action === "press" || button === "move") ? canvasApi.link(props.gid, row, col) : "";

    e.shiftKey && modiffier.push("S");
    e.ctrlKey && modiffier.push("C");
    e.altKey && modiffier.push("A");

    pointer.current = { row, col };

    if (url && action === "press") {
      const href = url.replace(/^\//, "file:///")
      if (href.match(/^\w+:/)) window.location.href = href;
    }
    if (!skip && button === "move") {
      (e.currentTarget as HTMLElement).style.cursor = url ? "pointer" : "";
    }

    skip || emit.send("neovim:mouse", gid, button, action, modiffier.join("-"), row, col);
  }

  function onMouseDown(e: React.MouseEvent) {
    clearTimeout(timer.current);

    timer.current = +setTimeout(() => {
      emit.share("ui:drag", props.gid);
    });

    onMouseEvent(e, "press");
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!(drag || options.mousemoveevent) || busy || mode?.short_name === "i") return;

    onMouseEvent(e, "drag", drag ? "" : "move");
  }

  function onMouseUp(e: React.MouseEvent) {
    clearTimeout(timer.current);

    if (drag) {
      emit.share("ui:drag", "");
    }
    onMouseEvent(e, "release");
  }

  function onDragStart(e: React.DragEvent) {
    dragging.current = { x: e.clientX, y: e.clientY };
  }

  function onDragEnd(e: React.DragEvent) {
    const match = props.style.transform.match(/^translate\((\d+)px, (\d+)px\)$/);

    if (match) {
      const offset = { x: +match[1] + e.clientX - dragging.current.x, y: +match[2] + e.clientY - dragging.current.y };
      const resize = {
        width: props.style.width + Math.min(0, offset.x),
        height: props.style.height + Math.min(0, offset.y),
      };

      dragging.current = { x: 0, y: 0 };
      setState(state => ({ ...state, dragging: false }));

      emit.share("ui:drag", "");
      emit.send("neovim:ui:position", props.gid, x2Col(Math.max(0, offset.x)), y2Row(Math.max(0, offset.y)));
      emit.send("neovim:ui:resize", props.gid, Math.max(x2Col(resize.width), 18), y2Row(resize.height));
    }
  }

  function onWheel(e: React.WheelEvent) {
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

  function onNeovimUiGridClear() {
    canvasApi.clear(props.gid, x2Col(props.style.width), y2Row(props.style.height));
  }

  function onNeovimUiGridFlush(flush: { cells: ICell[], scroll?: IScroll }[]) {
    flush.forEach(({ cells, scroll }) => canvasApi.push(props.gid, cells, scroll));
  }

  function openExtWindow(e: React.MouseEvent) {
    const width = x2Col(props.style.width);
    const height = y2Row(props.style.height);

    runCommand(e, `call nvim_win_set_config(0, { "width": ${width}, "height": ${height}, "external": 1 })`);
  }

  function dragExtWIndow(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    setState(state => ({ ...state, dragging: true }));
    emit.share("ui:drag", props.gid);
  }

  function toggleExtWindow(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    setState(state => ({ ...state, hidden: !state.hidden }));
  }

  React.useEffect(() => {
    const nomouse = ["", props.gid].indexOf(drag) < 0;

    setState(state => ({ ...state, nomouse, dragging: drag === "" ? false : state.dragging }));
  }, [drag === "" || drag === props.gid]);

  React.useEffect(() => {
    setState(state => ({ ...state, bufs }));
  }, [bufs]);

  function renderMoves() {
    return (
      <SubMenuComponent label="Move">
        { moves.map(({ font, label, command }) => (
          <MenuItemComponent key={command} leftSection={<i>{font}</i>} onClick={e => runCommand(e, command)}>{ label }</MenuItemComponent>
        )) }
      </SubMenuComponent>
    );
  }

  function renderWindowMenu() {
    return props.type === "normal" ? (
      <>
        <SubMenuComponent label="Buffers">
          { state.bufs.map(({ name, buffer, active }, i) => (
            <MenuItemComponent active={active} title={name} onClick={e => runCommand(e, `buffer ${buffer}`)} key={i}>
              { name.replace(/.*\//, "…/") }
            </MenuItemComponent>
          )) }
        </SubMenuComponent>
        <Menu.Divider />
        <MenuItemComponent leftSection={<i></i>} onClick={e => runCommand(e, "enew")}>New buffer</MenuItemComponent>
        <MenuItemComponent leftSection={<i></i>} onClick={e => runCommand(e, "vsplit")}>Split vertically</MenuItemComponent>
        <MenuItemComponent leftSection={<i></i>} onClick={e => runCommand(e, "split")}>Split horizontally</MenuItemComponent>
        { renderMoves() }
        <MenuItemComponent leftSection={<i>󰉡</i>} onClick={e => runCommand(e, "wincmd =")}>Equalize sizes</MenuItemComponent>
        <MenuItemComponent leftSection={<i>󰶭</i>} onClick={openExtWindow}>Open as external window</MenuItemComponent>
        <Menu.Divider />
        <MenuItemComponent leftSection={<i>{uiIcons.save}</i>} onClick={e => runCommand(e, "write")}>Save</MenuItemComponent>
      </>
    ) : (
      <>
        <MenuItemComponent leftSection={<i>{state.hidden ? "" : ""}</i>} onClick={toggleExtWindow}>{ state.hidden ? "Show" : "Hide" }</MenuItemComponent>
        { !state.hidden && <MenuItemComponent active={state.dragging} leftSection={<i>󰮐</i>} onClick={dragExtWIndow}>Drag to move</MenuItemComponent> }
        { !state.hidden && renderMoves() }
      </>
    );
  }

  return (
    <div className="animate fade-in envim-grid" data-nomouse={state.nomouse || undefined} data-shadow={(props.shadow && !state.hidden) || undefined}
      style={{ ...props.style, ...(state.hidden ? { height: 0 } : {}) }} draggable={state.dragging}
      onMouseDown={state.dragging ? undefined : onMouseDown}
      onMouseMove={state.dragging ? undefined : onMouseMove}
      onMouseUp={state.dragging ? undefined : onMouseUp}
      onWheel={state.dragging ? undefined : onWheel}
      onDragStart={state.dragging ? onDragStart : undefined}
      onDragEnd={state.dragging ? onDragEnd : undefined}
    >
      <div className="envim-grid-canvas">
        <canvas width={props.style.width * scale} height={props.style.height * scale} ref={canvas} />
      </div>
      { props.gid === 1 || !props.focusable ? null : (
        <>
          <div className="envim-grid-fab" data-hidden={state.hidden || undefined} onMouseDown={e => runCommand(e, "")}>
            <MenuComponent label={() => (
              <ActionIcon variant={state.hidden ? "filled" : "subtle"} color={state.hidden ? "orange" : "gray"} radius="xl" title="Window">
                <i></i>
              </ActionIcon>
            )}>
              { renderWindowMenu() }
              <Menu.Divider />
              <MenuItemComponent color="red" leftSection={<i>{uiIcons.close}</i>} onClick={e => runCommand(e, "confirm quit")}>Close</MenuItemComponent>
            </MenuComponent>
          </div>
        </>
      )}
    </div>
  );
}
