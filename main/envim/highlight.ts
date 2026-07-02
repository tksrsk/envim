import { IHighlight } from "common/interface";

export class Highlights {
  private hls: { [k: string]: { fg: number; bg: number; sp: number; } } = {};

  set(id: string, hl: IHighlight, ui: boolean) {
    const highlight = { fg: 0x01000000, bg: 0x02000000, sp: 0x03000000 };
    const old = this.get(id) || {};

    if (hl.foreground) highlight.fg = hl.foreground;
    if (hl.background) highlight.bg = hl.background;
    if (hl.special) highlight.sp = hl.special;

    [ highlight.fg, highlight.bg ] = hl.reverse ? [ highlight.bg, highlight.fg ] : [ highlight.fg, highlight.bg ];

    if (hl.bold) highlight.fg = 0x04000000 | highlight.fg;
    if (hl.italic) highlight.fg = 0x08000000 | highlight.fg;
    if (hl.altfont) highlight.fg = 0x10000000 | highlight.fg;
    if (hl.url) highlight.fg = 0x20000000 | highlight.fg;
    if (ui) highlight.bg = 0x04000000 | highlight.bg;
    if (hl.blend) highlight.bg = (hl.blend << 28) | highlight.bg;
    if (hl.strikethrough) highlight.sp = 0x04000000 | highlight.sp;
    if (hl.underline) highlight.sp = 0x08000000 | highlight.sp;
    if (hl.underdouble) highlight.sp = 0x10000000 | highlight.sp;
    if (hl.undercurl) highlight.sp = 0x20000000 | highlight.sp;
    if (hl.underdotted) highlight.sp = 0x40000000 | highlight.sp;
    if (hl.underdashed) highlight.sp = 0x80000000 | highlight.sp;

    this.hls[id] = highlight;

    return JSON.stringify(highlight) !== JSON.stringify(old);
  }

  get(id: string) {
    return this.hls[id];
  }
}
