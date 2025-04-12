import { IHighlight } from "common/interface";
import { Setting } from "./setting";
import { Cache } from "./cache";

interface IOptions {
  reverse?: boolean;
  normal?: boolean;
  lighten?: boolean;
}

const TYPE = "highlight";

class Highlight {
  public foreground: { normal: string; alpha: string; lighten: string; };
  public background: { normal: string; alpha: string; lighten: string; };
  public special: { normal: string; alpha: string; lighten: string; };
  public reverse?: boolean;
  public altfont?: boolean;
  private type: "normal" | "bold" | "italic";
  private decorate: ("strikethrough" | "underline" | "underdouble" | "undercurl" | "underdotted" | "underdashed" | "url")[];
  private url: string;

  constructor(highlight: IHighlight, alpha: number, lighten: number) {
    alpha = highlight.blend === undefined ? alpha : highlight.blend;
    alpha = (100 - alpha) / 100;
    lighten = (100 - lighten) / 100;

    this.background = this.intToColor(highlight.background, alpha, lighten);
    this.foreground = this.intToColor(highlight.foreground, alpha, lighten);
    this.special = highlight.special ? this.intToColor(highlight.special, alpha, lighten) : this.foreground;
    this.reverse = highlight.reverse || false;
    this.altfont = highlight.altfont || false;

    this.type = "normal";
    if (highlight.bold) this.type = "bold";
    if (highlight.italic) this.type = "italic";

    this.decorate = [];
    if (highlight.strikethrough) this.decorate.push("strikethrough");
    if (highlight.underline) this.decorate.push("underline");
    if (highlight.underdouble) this.decorate.push("underdouble");
    if (highlight.undercurl) this.decorate.push("undercurl");
    if (highlight.underdotted) this.decorate.push("underdotted");
    if (highlight.underdashed) this.decorate.push("underdashed");
    if (highlight.url) this.decorate.push("url");

    this.url = highlight.url || "";
  }

  private intToColor(color: number | undefined, a1: number, a2: number) {
    if (color === undefined || color < 0) return { normal: "", alpha: "", lighten: "" };

    const rgb = `${("000000" + color.toString(16)).slice(-6)}`;

    const r = Number(`0x${rgb[0]}${rgb[1]}`)
    const g = Number(`0x${rgb[2]}${rgb[3]}`)
    const b = Number(`0x${rgb[4]}${rgb[5]}`)

    return {
      normal: `#${rgb}`,
      alpha: `rgba(${r}, ${g}, ${b}, ${a1})`,
      lighten: `rgba(${r}, ${g}, ${b}, ${a2})`,
    };
  }

  font(size: number) {
    return `${this.fontStyle()} ${size}px ${this.fontFamily()}`;
  }

  fontFamily() {
    return {
      normal: `${this.altfont ? `"Alt",` : ""}"Regular","Icon","Git"`,
      bold: `${this.altfont ? `"Alt Bold",` : ""}"Bold","Icon","Git"`,
      italic: `${this.altfont ? `"Alt",` : ""}"Regular","Icon","Git"`
    }[this.type];
  }

  fontStyle() {
    return this.type === "italic" ? "italic" : "";
  }

  decoration() {
    return this.decorate;
  }

  link() {
    return this.url;
  }
}

export class Highlights {
  static setHighlight(id: string, ui: boolean, hl: IHighlight) {
    const alpha = ui ? Setting.opacity : 0;
    const lighten = alpha && Setting.options.ext_multigrid ? Math.sqrt(alpha / 100) * 100 : alpha;

    Cache.set<Highlight>(TYPE, id, new Highlight(hl, alpha, lighten));
  }

  static color(id: string, type: "foreground" | "background" | "special", options: IOptions = {}) {
    const reverse = !!Cache.get<Highlight>(TYPE, id)?.reverse !== !!options.reverse;

    if (reverse && type !== "special") {
      type = type === "foreground" ? "background" : "foreground";
    }

    const alpha = type === "background" && !options.normal ? "alpha" : "normal";
    const color1 = Cache.get<Highlight>(TYPE, 0) && Cache.get<Highlight>(TYPE, 0)[type];
    const color2 = Cache.get<Highlight>(TYPE, id) && Cache.get<Highlight>(TYPE, id)[type] || color1;

    if (options.lighten && type === "background") {
      return color2.lighten || color1.lighten;
    }

    return color2[alpha] || color1[alpha];
  }

  static style(id: string, options: IOptions = {}) {
    const background = Highlights.color(id, "background", options);
    const foreground = Highlights.color(id, "foreground", options);
    const special = Highlights.color(id, "special");
    const fontFamily = Highlights.fontFamily(id);
    const fontStyle = Highlights.fontStyle(id);
    const textDecoration = Highlights.decoration(id)
      .map(type => ({
        strikethrough: ["line-through", special],
        underline: ["underline", "solid", special],
        underdouble: ["underline", "double", special],
        undercurl: ["underline", "wavy", special],
        underdotted: ["underline", "dotted", special],
        underdashed: ["underline", "dashed", special],
        url: [],
      }[type]))
      .reduce((prev, type) => [ ...prev, ...type ], [])
      .filter((val, i, arr) => i === arr.indexOf(val))
      .sort(val => val === special ? -1 : 0)
      .join(" ");

    return { background, color: foreground, borderColor: foreground, fontFamily, fontStyle, textDecoration };
  }

  static font(id: string, size: number) {
    return Cache.get<Highlight>(TYPE, id)?.font(size) || "";
  }

  static fontFamily(id: string) {
    return Cache.get<Highlight>(TYPE, id)?.fontFamily() || "";
  }

  static fontStyle(id: string) {
    return Cache.get<Highlight>(TYPE, id)?.fontStyle() || "";
  }

  static decoration(id: string) {
    return Cache.get<Highlight>(TYPE, id)?.decoration() || [];
  }

  static link(id: string) {
    return Cache.get<Highlight>(TYPE, id)?.link();
  }
}
