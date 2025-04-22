import { NeovimClient } from "neovim";
import { Response } from "neovim/lib/host";
import { Tabpage, Buffer, Window } from "neovim/lib/api";

import { ITab, IBuffer, IMode, IMenu } from "common/interface";

import { Emit } from "../emit";
import { Function } from "./function";
import { Autocmd } from "./autocmd";
import { Clipboard } from "./clipboard";
import { Grids } from "./grid";
import { Highlights } from "./highlight";

export class App {
  private modes: IMode[] = [];
  private static nvim: NeovimClient;

  constructor(nvim: NeovimClient, init: boolean, workspace: string) {
    App.nvim = nvim;
    Emit.init();
    Highlights.init();
    Grids.init(init, workspace);
    Function.setup();
    Autocmd.setup();
    Clipboard.setup();
    nvim.on("request", this.onRequest);
    nvim.on("notification", this.onNotification);
    this.menu();
  }

  private onRequest = (method: string, args: any, res: Response) => {
    switch (method) {
      case "envim_clipboard": return Clipboard.paste(res);
    }
    console.log({ method, args });
  }

  private onNotification = (method: string, args: any) => {
    switch (method) {
      case "redraw" :return this.redraw(args);
      case "envim_clipboard": return Clipboard.copy(args[0], args[1]);
      case "envim_dirchanged": return Autocmd.dirchanged(args[0]);
      case "envim_setbackground": return Emit.share("envim:theme", args[0]);
      case "envim_openurl": return args.length && Emit.share("envim:browser", args[0], args[1] || "");
      case "envim_preview": return args.length === 2 && Emit.share("envim:preview", args[0], args[1]);
      case "envim_preview_toggle": return args.length === 3 && Emit.share("envim:preview:toggle", args[0], args[1], args[2]);
    }
  }

  private redraw(redraw: any[][]) {
    redraw.forEach(r => {
      const name = r.shift();
      switch (name) {
        /** ext_linegrid **/
        case "grid_resize":
          r.forEach(r => this.gridResize(r[0], r[1], r[2]));
        break;
        case "default_colors_set":
          r.forEach(r => this.defaultColorsSet(r[0], r[1], r[2]));
        break;
        case "hl_attr_define":
          this.hlAttrDefine(r);
        break;
        case "grid_line":
          r.forEach(r => this.gridLine(r[0], r[1], r[2], r[3]));
        break;
        case "grid_clear":
          r.forEach(r => this.gridClear(r[0]));
        break;
        case "grid_destroy":
          r.forEach(r => this.gridDestory(r[0]));
        break;
        case "grid_cursor_goto":
          r.forEach(r => this.gridCursorGoto(r[0], r[1], r[2]));
        break;
        case "grid_scroll":
          r.forEach(r => this.gridScroll(r[0], r[1], r[2], r[3], r[4], r[5], r[6]));
        break;

        /** ext_multigrid **/
        case "win_pos":
          r.forEach(r => this.winPos(r[0], r[1], r[2], r[3], r[4], r[5], true, 3, "normal"));
        break;
        case "win_float_pos":
          r.forEach(r => this.winFloatPos(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]));
        break;
        case "win_external_pos":
          r.forEach(r => this.winExternalPos(r[0], r[1]));
        break;
        case "msg_set_pos":
          r.forEach(r => this.msgSetPos(r[0], r[1]));
        break;
        case "win_hide":
          r.forEach(r => this.winHide(r[0]));
        break;
        case "win_close":
          r.forEach(r => this.winClose(r[0]));
        break;
        case "win_viewport":
          r.forEach(r => this.winViewport(r[0], r[2], r[3], r[6]));
        break;

        /** ext_tabline **/
        case "tabline_update":
          r.forEach(r => this.tablineUpdate(r[0], r[1], r[2], r[3]));
        break;

        /** ext_cmdline **/
        case "cmdline_show":
          r.forEach(r => this.cmdlineShow(r[0], r[1], r[2] || r[3], r[4]));
        break;
        case "cmdline_pos":
          r.forEach(r => this.cmdlinePos(r[0]));
        break;
        case "cmdline_special_char":
          r.forEach(r => this.cmdlineSpecialChar(r[0], r[1]));
        break;
        case "cmdline_hide":
          this.cmdlineShow([], 0, "", 0);
        break;
        case "cmdline_block_show":
          r.forEach(r => this.cmdlineBlockShow(r[0]));
        break;
        case "cmdline_block_append":
          r.forEach(r => this.cmdlineBlockAppend(r[0]));
        break;
        case "cmdline_block_hide":
          this.cmdlineBlockHide();
        break;

        /** ext_popupmenu **/
        case "popupmenu_show":
          r.forEach(r => this.popupmenuShow(r[0], r[1], r[2], r[3], r[4]));
        break;
        case "popupmenu_select":
          r.forEach(r => this.popupmenuSelect(r[0]));
        break;
        case "popupmenu_hide":
          this.popupmenuHide();
        break;

        /** ext_messages **/
        case "msg_show":
          this.msgShow(r);
        break;
        case "msg_showmode":
          r.forEach(r => this.msgShowmode(r[0]));
        break;
        case "msg_showcmd":
          r.forEach(r => this.msgShowcmd(r[0]));
        break;
        case "msg_ruler":
          r.forEach(r => this.msgRuler(r[0]));
        break;
        case "msg_clear":
          this.msgClear();
        break;
        case "msg_history_show":
          this.msgHistoryShow(r[0][0]);
        break;

        /** default **/
        case "mode_info_set":
          r.forEach(r => this.modeInfoSet(r[1]));
        break;
        case "mode_change":
          r.forEach(r => this.modeChange(r[1]));
        break;
        case "option_set":
          this.optionsSet(r);
        break;
        case "busy_start":
          this.busy(true);
        break;
        case "busy_stop":
          this.busy(false);
        break;
        case "update_menu":
          this.menu();
        break;
        case "flush":
          this.flush();
        break;
      }
    });
  }

  private gridResize(gid: number, width: number, height: number) {
    Grids.get(gid).resize(width, height);
    Grids.setStatus(gid, "show", true);
  }

  private defaultColorsSet(foreground: number, background: number, special: number) {
    foreground = foreground >= 0 ? foreground : 0xffffff;
    background = background >= 0 ? background : 0x000000;
    special = special >= 0 ? special : foreground;

    Highlights.set("0", { foreground, background, special }, true);
    Grids.refresh();
    Emit.update("highlight:set", false, [{id: "0", ui: true, hl: { foreground, background, special }}]);
  }

  private hlAttrDefine(highlights: any[]) {
    highlights = highlights.map(([id, hl, _, info]) => {
      const ui = info.some((info: { kind: string }) => info.kind === "ui");

      return { id, ui, hl }
    }).filter(({ id, hl, ui }) => Highlights.set(id, hl, ui));
    Emit.update("highlight:set", false, highlights);
  }

  private gridLine(gid: number, row: number, col: number, cells: string[][]) {
    let i = 0;
    cells.forEach(cell => {
      const repeat = cell.length >= 3 ? +cell[2] : 1;
      for (let j = 0; j < repeat; j++) {
        Grids.get(gid).setCell(row, col + i++, cell[0], cell.length > 1 ? cell[1] : "-1");
      }
    });
  }

  private gridClear(gid: number) {
    const { id, width, height } = Grids.get(gid).getInfo();

    Grids.get(gid).resize(width, height, true);
    Emit.send(`clear:${id}`);
  }

  private gridDestory(gid: number) {
    Grids.setStatus(gid, "delete", false);
  }

  private gridCursorGoto(gid: number, row: number, col: number) {
    Grids.cursor(gid, row, col);
  }

  private gridScroll(gid: number, top: number, bottom: number, left: number, right: number, rows: number, cols: number) {
    Grids.get(gid).setScroll(top, bottom, left, right, rows, cols)
  }

  private winPos(gid: number, win: Window | null, row: number, col: number, width: number, height: number, focusable: boolean, zIndex: number, type: "normal" | "floating" | "external") {
    const winsize = Grids.get().getInfo();
    const current = Grids.get(gid);
    const winid = win ? win.id : 0;
    const overwidth = Math.max(0, col + width - winsize.width);
    const overheight = Math.max(0, row + height - winsize.height);

    col = Math.min(winsize.width - 1, Math.max(0, col - overwidth));
    row = Math.min(winsize.height - 1, Math.max(0, row - overheight));
    zIndex = gid === 1 ? 1 : zIndex;

    const update = current.setInfo({ winid, x: col, y: row, width, height, zIndex, focusable, type });
    Grids.setStatus(gid, "show", update);
  }

  private winFloatPos(gid: number, win: Window, anchor: string, pgid: number, row: number, col: number, focusable: boolean, zIndex: number, compIndex?: number, screenRow?: number, screenCol?: number) {
    const current = Grids.get(gid).getInfo();
    const parent = Grids.get(pgid).getInfo();

    row = screenRow !== undefined ? screenRow : parent.y + (anchor[0] === "N" ? row : row - current.height);
    col = screenCol !== undefined ? screenCol : parent.x + (anchor[1] === "W" ? col : col - current.width);
    zIndex = compIndex ? compIndex : zIndex;

    this.winPos(gid, win, row, col, current.width, current.height, focusable, Math.max(zIndex, parent.zIndex + 4), "floating");
  }

  private async winExternalPos(gid: number, win: Window) {
    if (!await win.valid) return;

    const nvim = App.nvim;
    const { x, y } = Grids.get(gid).getInfo();
    const width = await win.width;
    const height = await win.height;

    if (App.nvim === nvim) {
      this.winPos(gid, win, y, x, width, height, true, 10000, "external");
      Grids.flush();
    }
  }

  private msgSetPos(gid: number, row: number) {
    const winsize = Grids.get().getInfo();
    const width = winsize.width;
    const height = winsize.height - row;

    this.winPos(gid, null, row, 0, width, height, false, 50, "floating");
  }

  private winHide(gid: number) {
    Grids.setStatus(gid, "hide", false);
  }

  private winClose(gid: number) {
    Grids.setStatus(gid, "delete", false);
  }

  private winViewport(gid: number, top: number, bottom: number, total: number) {
    Grids.get(gid, false).setViewport(top, bottom, total);
  }

  private async tablineUpdate(ctab: Tabpage, tabs: { tab: Tabpage, name: string }[], cbuf: Buffer, bufs: { buffer: Buffer, name: string }[]) {
    const nvim = App.nvim;
    const next: { tabs: ITab[]; bufs: IBuffer[] } = { tabs: [], bufs: [] };

    for (let i = 0; i < tabs.length; i++) {
      const { tab, name } = tabs[i];
      const buffer = await tab.window.buffer.catch(() => null);

      if (buffer?.data) {
        const active = ctab.data === tab.data;

        next.tabs.push({ name, buffer: +buffer.data, active });
      }
    }

    for (let i = 0; i < bufs.length; i++) {
      const { buffer, name } = bufs[i];
      const active = cbuf.data === buffer.data;

      buffer.data && next.bufs.push({ name, buffer: +buffer.data, active });
    }

    App.nvim === nvim && Emit.update("tabline:update", true, next.tabs, next.bufs);
  }

  private cmdlineShow(content: string[][], pos: number, prompt: string, indent: number) {
    Emit.update("cmdline:show", true, content, pos, prompt, indent);
  }

  private cmdlinePos(pos: number) {
    Emit.update("cmdline:cursor", true, pos);
  }

  private cmdlineSpecialChar(c: string, shift: boolean) {
    Emit.send("cmdline:special", c, shift);
  }

  private cmdlineBlockShow(lines: string[][][]) {
    Emit.update("cmdline:blockshow", true, lines);
  }

  private cmdlineBlockAppend(line: string[][]) {
    Emit.update("cmdline:blockshow", true, [line]);
  }

  private cmdlineBlockHide() {
    Emit.update("cmdline:blockhide", true);
  }

  private popupmenuShow(items: string[][], selected: number, row: number, col: number, gid: number) {
    const parent = Grids.get().getInfo();
    const current = gid === -1 ? { y: 1, x: parent.width * 0.1 + 3, zIndex: 20 } : Grids.get(gid).getInfo();
    const [ x, y ] = [ col + current.x, row + current.y ];
    const height = Math.min(Math.max(y, parent.height - y - 1), items.length);
    const zIndex = current.zIndex + 1;

    row = y + height >= parent.height ? y - height : y + 1;
    col = Math.min(x, parent.width - 10);

    Emit.send("popupmenu:show", {
      items: items.map(([ word, kind, menu ]) => ({ word, kind, menu })),
      selected,
      start: 0,
      row,
      col,
      height,
      zIndex,
    });
  }

  private popupmenuSelect(selected: number) {
    Emit.send("popupmenu:select", selected);
  }

  private popupmenuHide() {
    Emit.send("popupmenu:hide");
  }

  private msgShow(messages: [string, [string, string][], boolean][]) {
    const replace = messages.some(message => message[2]);
    const entries = messages
      .map(message => this.convertMessage(message[0], message[1]))
      .filter(({ contents }) => contents.length);

    Emit.update("messages:show", true, entries, replace);
  }

  private msgClear() {
    Emit.update("messages:show", true, [], true);
  }

  private msgShowmode(contents: [string, string][]) {
    Emit.update("messages:mode", true, this.convertMessage("mode", contents));
  }

  private msgShowcmd(contents: [string, string][]) {
    Emit.update("messages:command", true, this.convertMessage("command", contents));
  }

  private msgRuler(contents: [string, string][]) {
    Emit.update("messages:ruler", true, this.convertMessage("ruler", contents));
  }

  private msgHistoryShow(entries: [string, [string, string][]][]) {
    const history = entries.map(
      ([kind, contents]) => this.convertMessage(kind, contents)
    ).filter(({ contents }) => contents.length);

    if (history.length) {
      App.nvim.command("messages clear");
      Emit.send("messages:history", history);
    }
  }

  private convertMessage(kind: string, contents: [string, string][]) {
    return {
      kind,
      contents: contents
        .map(([hl, content], i) => ({ hl, content: i ? content : content.replace(/^\s*\n/, "") }))
        .filter(({ content }) => content.length)
    };
  }

  private modeInfoSet(modes: IMode[]) {
    this.modes = modes;
  }

  private modeChange(index: number) {
    Grids.setMode(this.modes[index]);
  }

  private optionsSet(options: string[][]) {
    Emit.send("option:set", options.reduce((obj: { [k: string]: string }, [name, value]) => {
      obj[name] = value;
      return obj;
    }, {}));
  }

  private busy(busy: boolean) {
    Emit.update("app:busy", true, busy);
  }

  private async menu() {
    const nvim = App.nvim;
    const menus: IMenu[] = await App.nvim.call("menu_get", [""]);

    App.nvim === nvim && Emit.send("menu:update", menus.filter(({ name }) => !name.match(/^(PopUp)|\]/)));
  }

  private flush() {
    Grids.flush();
  }
}
