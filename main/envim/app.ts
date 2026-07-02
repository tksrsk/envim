import { Response } from "neovim/lib/host";
import { Tabpage, Buffer, Window } from "neovim/lib/api";

import { ITab, IBuffer, IMode, IMenu } from "common/interface";

import { Emit } from "main/emit";
import { Workspace } from "main/envim/workspace";

export class App {
  private modes: IMode[] = [];

  constructor(private readonly workspace: Workspace) {
    this.workspace.nvim.on("request", this.onRequest);
    this.workspace.nvim.on("notification", this.onNotification);
    this.menu();
  }

  private onRequest = (method: string, args: any, res: Response) => {
    switch (method) {
      case "envim_clipboard": return this.workspace.clipboard.paste(res);
    }
    console.log({ method, args });
  }

  private onNotification = (method: string, args: any) => {
    switch (method) {
      case "redraw": return this.redraw(args);
      case "envim_clipboard": return this.workspace.clipboard.copy(args[0], args[1]);
      case "envim_dirchanged": return this.workspace.autocmd.dirchanged(args[0]);
      case "envim_setbackground": return Emit.share("envim:theme", args[0]);
      case "envim_openurl": return args.length && this.workspace.emit.share("envim:browser", args[0], args[1] || "");
      case "envim_webview": return args.length === 3 && this.workspace.emit.share("envim:webview", args[0], args[1], args[2]);
      case "envim_acp_stdout": return this.workspace.emit.share("acp:stdout", args[0]);
      case "envim_acp_exited": return this.workspace.emit.share("acp:exited");
      case "envim_acp_error": return this.workspace.emit.share("acp:error", args[0]);
      case "envim_acp_file_add": return this.workspace.emit.send("acp:file-add", args[0]);
      case "envim_acp_terminal_output": return this.workspace.emit.share("acp:terminal-output", args[0]);
      case "envim_acp_terminal_exit": return this.workspace.emit.share("acp:terminal-exit", args[0]);
      case "envim_mcp_open": return this.workspace.mcpGateway.onOpen(args[0]);
      case "envim_mcp_data": return this.workspace.mcpGateway.onData(args[0], args[1]);
      case "envim_mcp_close": return this.workspace.mcpGateway.onClose(args[0]);
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
    this.workspace.grids.get(gid).resize(width, height);
    this.workspace.grids.setStatus(gid, "show", true);
  }

  private defaultColorsSet(foreground: number, background: number, special: number) {
    foreground = foreground >= 0 ? foreground : 0xffffff;
    background = background >= 0 ? background : 0x000000;
    special = special >= 0 ? special : foreground;

    this.workspace.highlights.set("0", { foreground, background, special }, true);
    this.workspace.grids.refresh();
    this.workspace.emit.update("highlight:set", false, [{id: "0", ui: true, hl: { foreground, background, special }}]);
  }

  private hlAttrDefine(highlights: any[]) {
    highlights = highlights.map(([id, hl, _, info]) => {
      const ui = info.some((info: { kind: string }) => info.kind === "ui");

      return { id, ui, hl };
    }).filter(({ id, hl, ui }) => this.workspace.highlights.set(id, hl, ui));
    this.workspace.emit.update("highlight:set", false, highlights);
  }

  private gridLine(gid: number, row: number, col: number, cells: string[][]) {
    let i = 0;
    cells.forEach(cell => {
      const repeat = cell.length >= 3 ? +cell[2] : 1;
      for (let j = 0; j < repeat; j++) {
        this.workspace.grids.get(gid).setCell(row, col + i++, cell[0], cell.length > 1 ? cell[1] : "-1");
      }
    });
  }

  private gridClear(gid: number) {
    const { width, height } = this.workspace.grids.get(gid).getInfo();

    this.workspace.grids.get(gid).resize(width, height, true);
    this.workspace.emit.send(`clear:${gid}`);
  }

  private gridDestory(gid: number) {
    this.workspace.grids.setStatus(gid, "delete", false);
  }

  private gridCursorGoto(gid: number, row: number, col: number) {
    this.workspace.grids.cursor(gid, row, col);
  }

  private gridScroll(gid: number, top: number, bottom: number, left: number, right: number, rows: number, cols: number) {
    this.workspace.grids.get(gid).setScroll(top, bottom, left, right, rows, cols);
  }

  private winPos(gid: number, win: Window | null, row: number, col: number, width: number, height: number, focusable: boolean, zIndex: number, type: "normal" | "floating" | "external") {
    const winsize = this.workspace.grids.get().getInfo();
    const current = this.workspace.grids.get(gid);
    const winid = win ? win.id : 0;
    const overwidth = Math.max(0, col + width - winsize.width);
    const overheight = Math.max(0, row + height - winsize.height);

    col = Math.min(winsize.width - 1, Math.max(0, col - overwidth));
    row = Math.min(winsize.height - 1, Math.max(0, row - overheight));
    zIndex = gid === 1 ? 1 : zIndex;

    const update = current.setInfo({ winid, x: col, y: row, width, height, zIndex, focusable, type });
    this.workspace.grids.setStatus(gid, "show", update);
  }

  private winFloatPos(gid: number, win: Window, anchor: string, pgid: number, row: number, col: number, focusable: boolean, zIndex: number, compIndex?: number, screenRow?: number, screenCol?: number) {
    const current = this.workspace.grids.get(gid).getInfo();
    const parent = this.workspace.grids.get(pgid).getInfo();
    const index = compIndex ? compIndex : zIndex;

    row = screenRow !== undefined ? screenRow : parent.y + (anchor[0] === "N" ? row : row - current.height);
    col = screenCol !== undefined ? screenCol : parent.x + (anchor[1] === "W" ? col : col - current.width);

    this.winPos(gid, win, row, col, current.width, current.height, focusable, Math.max(index, parent.zIndex + 4), "floating");
    this.workspace.grids.setLayer(gid, zIndex);
  }

  private async winExternalPos(gid: number, win: Window) {
    if (!await win.valid) return;

    const nvim = this.workspace.nvim;
    const { x, y } = this.workspace.grids.get(gid).getInfo();
    const width = await win.width;
    const height = await win.height;

    if (this.workspace.nvim === nvim) {
      this.winPos(gid, win, y, x, width, height, true, 10000, "external");
      this.workspace.grids.flush();
    }
  }

  private msgSetPos(gid: number, row: number) {
    const winsize = this.workspace.grids.get().getInfo();
    const width = winsize.width;
    const height = winsize.height - row;

    this.winPos(gid, null, row, 0, width, height, false, 50, "floating");
  }

  private winHide(gid: number) {
    this.workspace.grids.setStatus(gid, "hide", false);
  }

  private winClose(gid: number) {
    this.workspace.grids.setStatus(gid, "delete", false);
  }

  private winViewport(gid: number, top: number, bottom: number, total: number) {
    this.workspace.grids.get(gid, false).setViewport(top, bottom, total);
  }

  private async tablineUpdate(ctab: Tabpage, tabs: { tab: Tabpage, name: string }[], cbuf: Buffer, bufs: { buffer: Buffer, name: string }[]) {
    const next: { tabs: ITab[]; bufs: IBuffer[] } = { tabs: [], bufs: [] };

    for (let i = 0; i < tabs.length; i++) {
      const { tab, name } = tabs[i];
      const buffer = await tab.window.buffer.catch(() => null);

      if (buffer?.data) {
        const active = ctab.data === tab.data;

        next.tabs.push({ name: decodeURIComponent(name), buffer: +buffer.data, active });
      }
    }

    for (let i = 0; i < bufs.length; i++) {
      const { buffer, name } = bufs[i];
      const active = cbuf.data === buffer.data;

      buffer.data && next.bufs.push({ name, buffer: +buffer.data, active });
    }

    this.workspace.emit.update("tabline:update", true, next.tabs, next.bufs);
  }

  private cmdlineShow(content: string[][], pos: number, prompt: string, indent: number) {
    this.workspace.emit.update("cmdline:show", true, content, pos, prompt, indent);
  }

  private cmdlinePos(pos: number) {
    this.workspace.emit.update("cmdline:cursor", true, pos);
  }

  private cmdlineSpecialChar(c: string, shift: boolean) {
    this.workspace.emit.send("cmdline:special", c, shift);
  }

  private cmdlineBlockShow(lines: string[][][]) {
    this.workspace.emit.update("cmdline:blockshow", true, lines);
  }

  private cmdlineBlockAppend(line: string[][]) {
    this.workspace.emit.update("cmdline:blockshow", true, [line]);
  }

  private cmdlineBlockHide() {
    this.workspace.emit.update("cmdline:blockhide", true);
  }

  private popupmenuShow(items: string[][], selected: number, row: number, col: number, gid: number) {
    const parent = this.workspace.grids.get().getInfo();
    const current = gid === -1 ? { y: 1, x: parent.width * 0.1 + 3, zIndex: 20 } : this.workspace.grids.get(gid).getInfo();
    const [ x, y ] = [ col + current.x, row + current.y ];
    const height = Math.min(Math.max(y, parent.height - y - 1), items.length);
    const zIndex = current.zIndex + 1;

    row = y + height >= parent.height ? y - height : y + 1;
    col = Math.min(x, parent.width - 10);

    this.workspace.emit.send("popupmenu:show", {
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
    this.workspace.emit.send("popupmenu:select", selected);
  }

  private popupmenuHide() {
    this.workspace.emit.send("popupmenu:hide");
  }

  private msgShow(messages: [string, [string, string][], boolean][]) {
    const replace = messages.some(message => message[2]);
    const entries = messages
      .map(message => this.convertMessage(message[0], message[1]))
      .filter(({ contents }) => contents.length);

    this.workspace.emit.update("messages:show", true, entries, replace);
  }

  private msgClear() {
    this.workspace.emit.update("messages:show", true, [], true);
  }

  private msgShowmode(contents: [string, string][]) {
    this.workspace.emit.update("messages:mode", true, this.convertMessage("mode", contents));
  }

  private msgShowcmd(contents: [string, string][]) {
    this.workspace.emit.update("messages:command", true, this.convertMessage("command", contents));
  }

  private msgRuler(contents: [string, string][]) {
    this.workspace.emit.update("messages:ruler", true, this.convertMessage("ruler", contents));
  }

  private msgHistoryShow(entries: [string, [string, string][]][]) {
    const history = entries.map(
      ([kind, contents]) => this.convertMessage(kind, contents)
    ).filter(({ contents }) => contents.length);

    if (history.length) {
      this.workspace.nvim.command("messages clear");
      this.workspace.emit.send("messages:history", history);
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
    this.workspace.grids.setMode(this.modes[index]);
  }

  private optionsSet(options: string[][]) {
    this.workspace.emit.send("option:set", options.reduce((obj: { [k: string]: string }, [name, value]) => {
      obj[name] = value;
      return obj;
    }, {}));
  }

  private busy(busy: boolean) {
    this.workspace.emit.update("app:busy", true, busy);
  }

  private async menu() {
    const menus: IMenu[] = await this.workspace.nvim.call("menu_get", [""]);

    this.workspace.emit.send("menu:update", menus.filter(({ name }) => !name.match(/^(PopUp)|\]/)));
  }

  private flush() {
    this.workspace.grids.flush();
  }
}
