import { IWindow, ICell, IScroll, IMode } from "common/interface";

import { Emit } from "../emit";
import { Highlights } from "./highlight";

class Grid {
  private info: IWindow;
  private lines: { cell: ICell, hl: { fg: number; bg: number; sp: number } }[][] = [];
  private flush: { cells: ICell[], scroll?: IScroll }[] = [];
  private dirty: { [k: string]: ICell } = {};
  private viewport: { top: number; bottom: number; total: number; } = { top: 0, bottom: 0, total: 0 };
  private ready: "init" | "resize" | true = "init";
  private size?: { width: number; height: number; };

  constructor(gid: number, workspace: string, width :number, height: number) {
    const id = `${workspace}.${gid}`;

    this.info = { id, gid, winid: 0, x: 0, y: 0, width: 0, height: 0, zIndex: 1, focusable: true, focus: false, shadow: true, type: "normal", status: "hide" };
    this.resize(width, height);
  }

  setInfo(info: Object) {
    const { id, gid, ...curr } = this.info;
    const next = { ...curr, ...info };
    const update = JSON.stringify(curr) !== JSON.stringify(next);

    if (update) {
      this.resize(next.width, next.height);
      this.info = { id, gid, ...next };
    }

    return update;
  }

  getInfo() {
    return this.info;
  }

  resize(width :number, height: number, clear: boolean = false) {
    if (clear === false && this.info.width === width && this.info.height === height) return;
    const old = clear ? [] : this.lines;

    this.size = this.size || { width: this.info.width, height: this.info.height };
    this.ready = this.ready === "init" ? "init" : this.size.width === width && this.size.height === height || "resize";
    this.info.width = width;
    this.info.height = height;
    this.lines = [];

    for (let i = 0; i < height; i++) {
      this.lines.push([]);
      for (let j = 0; j < width; j++) {
        const cell = old[i] && old[i][j] ? old[i][j] : this.getDefault(i, j);
        this.lines[i].push(cell);
      }
    }
  }

  getCursorPos(y: number, x: number) {
    const { width } = this.getCell(y, x).cell;

    y = this.info.status === "show" && this.info.height > y ? y + this.info.y : -1;
    x = this.info.status === "show" && this.info.width > x ? x + this.info.x : -1;

    return { x, y, width, zIndex: this.info.zIndex + 1 };
  }

  setViewport(top: number, bottom: number, total: number) {
    this.viewport = { top, bottom, total };
  }

  getDefault(row: number, col: number) {
    return {
      cell: { row, col, text: " ", hl: "0", width: 0 },
      hl: { fg: 0, bg: 0, sp: 0 },
    };
  }

  refresh() {
    this.lines.forEach(line => line.forEach(({ cell }) => {
      this.dirty[`${cell.row},${cell.col}`] = cell;
    }));
  }

  private getCell(row: number, col: number) {
    return (this.lines[row] && this.lines[row][col]) ? this.lines[row][col] : this.getDefault(row, col);
  }

  setCell(row: number, col: number, text: string, hl: string) {
    const prev = this.getCell(row, col - 1).cell;
    const cell = this.getCell(row, col).cell;

    hl = +hl < 0 ? prev.hl : hl;

    const hl1 = Highlights.get(hl);
    const hl2 = this.getCell(row, col).hl;
    const dirty = (hl1.fg ^ hl2.fg || cell.text !== text) || (hl1.bg ^ hl2.bg) || (hl1.sp ^ hl2.sp);

    (text === "") && (prev.width = 2);

    if (dirty) {
      const next = this.getCell(row, col + 1).cell;
      [ cell.text, cell.hl, cell.width ] = [ text, hl, text.length ];
      [ hl2.fg, hl2.bg, hl2.sp, ] = [ hl1.fg, hl1.bg, hl1.sp ];

      this.dirty[`${cell.row},${cell.col}`] = cell;
      this.dirty[`${next.row},${next.col}`] = next;
    }
  }

  setScroll(top: number, bottom: number, left: number, right: number, rows: number, cols: number) {
    const cells = this.getDirty();
    const scroll = { x: left, y: top, width: right - left, height: bottom - top, rows, cols };
    const y = rows > 0
      ? { limit: bottom - top - rows, start: top, direction: 1 }
      : { limit: bottom - top + rows, start: bottom - 1, direction: -1 };
    const x = cols > 0
      ? { limit: right - left - cols, start: left, direction: 1 }
      : { limit: right - left + cols, start: right - 1, direction: -1 };

    for (let i = 0; i < y.limit; i++) {
      const trow = y.start + y.direction * i;
      const srow = trow + rows;
      for (let j = 0; j < x.limit; j++) {
        const tcol = x.start + x.direction * j;
        const scol = tcol + cols;

        const scell = this.getCell(srow, scol);
        const tcell = this.getCell(trow, tcol);

        [ tcell.cell.text, tcell.cell.hl, tcell.cell.width ] = [ scell.cell.text, scell.cell.hl, scell.cell.width ];
        [ tcell.hl.fg, tcell.hl.bg, tcell.hl.sp ] = [ scell.hl.fg, scell.hl.bg, scell.hl.sp ];
      }
    }

    this.flush.push({ cells, scroll });
  }

  private getDirty() {
    const dirty = this.dirty;

    this.dirty = {};
    return JSON.parse(JSON.stringify(Object.values(dirty).filter(({ width }) => width)));
  }

  getFlush() {
    if (this.ready !== true) return {};

    const { flush, viewport } = this;
    this.flush = [];

    const cells = this.getDirty();
    cells.length && flush.push({ cells });

    return { flush, viewport };
  }

  onReady() {
    this.ready = true;
    delete(this.size);
  }
}

export class Grids {
  private static grids: { [k: number]: Grid } = {};
  private static layer: { [i: number]: { parent: number, children: number[] }[] } = {};
  private static default: 1 = 1;
  private static active: { gid: number; row: number; col: number; } = { gid: 0, row: 0, col: 0 };
  private static changes: { [k: number]: number } = {};
  private static mode?: IMode;
  private static workspace: { current: string; caches: { [k: string]: Grid[] } } = { current: "", caches: {} };

  static init(init: boolean, workspace: string) {
    Grids.workspace.caches[Grids.workspace.current] = [];
    Object.values(Grids.grids).forEach(grid => Grids.workspace.caches[Grids.workspace.current].push(grid));

    Grids.grids = {};
    Grids.layer = {};
    Grids.active = { gid: 0, row: 0, col: 0 };
    Grids.changes = {};
    Grids.workspace.current = workspace;

    init || Grids.workspace.caches[workspace].forEach(grid => {
      const { gid } = grid.getInfo();

      Grids.grids[gid] = grid;
    });
  }

  static disconnect() {
    Object.keys(Grids.grids).forEach(gid => Grids.setStatus(+gid, "delete", true));
    Grids.flush();
  }

  static get(gid: number = Grids.default, add: boolean = true) {
    const curr = Grids.grids[gid] || new Grid(gid, Grids.workspace.current, 0, 0);

    if (!Grids.grids[gid] && add) {
      Grids.grids[gid] = curr;
    }

    return curr;
  }

  static findByWinId(winid: number) {
    return Object.values(Grids.grids).find(grid => grid.getInfo().winid === winid );
  }

  static cursor(gid: number, row: number, col: number) {
    if (Object.keys(Grids.grids).length <= 1 || gid !== Grids.default) {
      const active = Grids.get(Grids.active.gid, false).getInfo();

      active.gid !== gid &&  Grids.setStatus(active.gid, active.status, true);
      Grids.active = { gid, row, col };
      Grids.setStatus(gid, "show", true);
    }
  }

  static setStatus(gid: number, status: "show" | "hide" | "delete", update: boolean) {
    if (Grids.get(gid, false).setInfo({ status }) || update) {
      Grids.changes[gid] = gid;
    }
    if (status === "delete") {
      Object.entries(Grids.layer).forEach(([zIndex, layers]) => layers.some(layer => {
        if (layer.parent === gid) {
          layers = layers.filter(item => item !== layer);
          layers.length || delete(Grids.layer[+zIndex]);
        } else {
          layer.children = layer.children.filter(child => child !== gid);
        }
      }));
    }
  }

  static setMode(mode: IMode) {
    Grids.mode = mode;
  }

  static setLayer(gid: number, zIndex: number) {
    if (!Grids.layer[zIndex]) {
      Grids.layer[zIndex] = [];
    }

    const exists = Grids.layer[zIndex].some(layer => {
      if (layer.parent === gid) return;

      const current = Grids.get(gid).getInfo();
      const parent = Grids.get(layer.parent).getInfo();

      if (
        current.x < parent.x && current.y < parent.y &&
        (current.x + current.width) > (parent.x + parent.width) &&
        (current.y + current.height) > (parent.y + parent.height)
      ) {
        Grids.changes[layer.parent] = layer.parent;
        Grids.changes[gid] = gid;
        Grids.get(layer.parent).setInfo({ shadow: false });
        Grids.get(gid).setInfo({ shadow: true });
        layer.children = [ layer.parent, ...layer.children.filter(child => child !== gid) ];
        layer.parent = gid;
        return true;
      }
      if (
        parent.x < current.x && parent.y < current.y &&
        (parent.x + parent.width) > (current.x + current.width) &&
        (parent.y + parent.height) > (current.y + current.height)
      ) {
        Grids.changes[gid] = gid;
        Grids.get(gid).setInfo({ shadow: false });
        layer.children = [ gid, ...layer.children.filter(child => child !== gid) ];
        return true;
      }
    });

    exists || Grids.layer[zIndex].push({ parent: gid, children: [] });
  }

  static refresh() {
    Object.values(Grids.grids).forEach(grid => grid.refresh());
  }

  static flush() {
    const winsize = Grids.get().getInfo();
    const cursor = Grids.get(Grids.active.gid, false).getCursorPos(Grids.active.row, Grids.active.col);

    if (cursor && cursor.x >= 0 && cursor.y >= 0) {
      Emit.update("grid:cursor", false, cursor);
    }

    const wins: IWindow[] = Object.values(Grids.changes).map(grid => {
      const info = { ...Grids.get(grid).getInfo() };

      info.focus = info.status === "show" && info.gid === Grids.active.gid && Grids.mode?.short_name !== "c";
      info.status = info.width && info.height ? info.status : "delete";

      if (info.status === "delete") {
        delete(Grids.grids[info.gid]);
      }

      if (info.status === "show" && winsize.width < info.width || winsize.height < info.height) {
        Emit.share("envim:resize", grid, Math.min(winsize.width - 2, info.width), Math.min(winsize.height - 2, info.height));
      }

      return info;
    });

    Grids.changes = {};
    wins.length && Emit.update("win:pos", false, wins);

    Object.values(Grids.grids).map(grid => {
      const { id } = grid.getInfo();
      const { flush, viewport } = grid.getFlush();
      flush && flush.length && Emit.send(`flush:${id}`, flush);
      viewport && Emit.update(`viewport:${id}`, false, viewport.top, viewport.bottom, viewport.total);
    });

    Emit.update("mode:change", true, Grids.mode);
  }
}
