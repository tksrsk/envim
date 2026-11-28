import type { ICell, IScroll } from "common/interface";

import type { Highlights } from "../highlight";
import type { ISetting } from "common/setting";

export interface DecorationStroke {
  points: { x: number; y: number }[];
  width: number;
  color: string;
}

interface FontMetrics {
  size: number;
  scale: number;
  width: number;
  height: number;
}

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

const scrollDuration = 100;

interface ScrollAnimation {
  region: IScroll;
  start: number;
  frameTime?: number;
  fromX: number;
  fromY: number;
  offsetX: number;
  offsetY: number;
}

export abstract class Renderer {
  protected readonly font: FontMetrics;
  private dirty = true;
  private animation?: ScrollAnimation;
  private links = new Map<string, string>();
  private failed = false;

  protected constructor(
    protected readonly canvas: HTMLCanvasElement,
    protected lighten: boolean,
    protected readonly highlights: Highlights,
    { size, scale, width, height }: ISetting["font"],
  ) {
    this.font = { size: size * scale, scale, width: width * scale, height: height * scale };
  }

  protected get available() {
    return !this.failed;
  }

  protected abstract resize(color: string): boolean;
  protected abstract drawBackground(rect: Area, color: string): boolean;
  protected abstract drawCells(cells: ICell[]): boolean;
  protected abstract captureFrame(): void;
  protected abstract copyPixels(area: Area, x: number, y: number): boolean;
  protected abstract present(region?: Area, dx?: number, dy?: number, fromX?: number, fromY?: number): boolean;

  update(lighten: boolean) {
    this.lighten = lighten;
    this.animation = undefined;
    this.dirty = true;
    if (!this.failed) this.failed = !this.resize(this.backgroundColor("0"));
  }

  clear() {
    this.links.clear();
    this.animation = undefined;
    this.dirty = true;
    if (this.failed) return;

    const { width, height } = this.canvas;
    this.failed = !this.drawBackground({ x: 0, y: 0, width, height }, this.backgroundColor("0"));
  }

  push(cells: ICell[], scroll?: IScroll) {
    if (!this.available) return;
    if (cells.length) {
      this.failed = !this.drawCells(cells);
      this.dirty = true;
    }
    if (!this.failed && scroll) this.applyScroll(scroll);
  }

  link(row: number, col: number) {
    const hl = this.links.get(`${row},${col}`);
    return hl && this.highlights.link(hl);
  }

  private applyScroll(scroll: IScroll) {
    if ((!scroll.rows && !scroll.cols) || scroll.width <= 0 || scroll.height <= 0 ||
        !this.canvas.width || !this.canvas.height) return;

    const previous = this.animation;
    this.animation = this.startScroll(scroll);
    if (this.animation && (!previous || previous.frameTime !== undefined)) this.captureFrame();

    this.scrollLinks(scroll);
    this.scrollPixels(scroll);
    this.dirty = true;
  }

  render(time: number) {
    if (!this.available || (!this.dirty && !this.animation)) return false;
    this.dirty = false;
    if (!this.canvas.width || !this.canvas.height) {
      this.animation = undefined;
      return false;
    }

    const frame = this.scrollFrame(time);
    if (!frame) this.animation = undefined;
    this.failed = !this.present(frame?.region, frame?.dx, frame?.dy, frame?.fromX, frame?.fromY);
    return !this.failed && !!frame;
  }

  protected backgroundColor(hl: string) {
    return this.highlights.color(hl, "background", { lighten: this.lighten });
  }

  protected decorations(cells: ICell[]) {
    const { font, highlights, links } = this;
    const strokes: DecorationStroke[] = [];
    const lineWidth = font.scale;

    for (const { row, col, width, hl } of cells) {
      const types = highlights.decoration(hl);
      const isLink = types.includes("url");
      for (let i = 0; i < width; i++) {
        const key = `${row},${col + i}`;
        if (isLink) links.set(key, hl);
        else links.delete(key);
      }
      if (!types.length || width <= 0) continue;

      const x = col * font.width;
      const y = row * font.height;
      const right = x + width * font.width;
      const bottom = y + font.height - lineWidth;
      const color = highlights.color(hl, "special");
      const line = (y: number, left = x, end = right) => {
        strokes.push({ points: [{ x: left, y }, { x: end, y }], width: lineWidth, color });
      };

      for (const type of types) {
        switch (type) {
          case "strikethrough":
            line(y + Math.floor((font.height + lineWidth) / 2));
            break;
          case "underline":
            line(bottom);
            break;
          case "underdouble":
            line(bottom);
            line(bottom - lineWidth * 2);
            break;
          case "underdotted":
          case "underdashed": {
            const length = lineWidth * (type === "underdotted" ? 2 : 3);
            for (let left = x; left < right; left += lineWidth * 4) {
              line(bottom, left, Math.min(right, left + length));
            }
            break;
          }
          case "undercurl": {
            const cycle = font.width / 8;
            const points: DecorationStroke["points"] = [];
            for (let i = 0; i < width * 4; i++) {
              const lower = i % 2 !== 0;
              const centerX = x + (i * 2 + 1) * cycle;
              const centerY = y + font.height - cycle * (lower ? 1.5 : 2);
              for (let step = 0; step <= 8; step++) {
                const angle = (lower ? 1.1 + step / 10 : 0.9 - step / 10) * Math.PI;
                points.push({ x: centerX + Math.cos(angle) * cycle, y: centerY + Math.sin(angle) * cycle });
              }
            }
            strokes.push({ points, width: lineWidth, color });
            break;
          }
        }
      }
    }
    return strokes;
  }

  private startScroll(region: IScroll): ScrollAnimation | undefined {
    const previous = this.animation;
    const { font } = this;
    const { x, y, width, height, rows, cols } = region;
    const continuing = previous?.region.x === x && previous.region.y === y &&
      previous.region.width === width && previous.region.height === height;
    const maxX = width * font.width;
    const maxY = height * font.height;
    const fromX = Math.max(-maxX, Math.min(maxX, cols * font.width + (continuing ? previous.offsetX : 0)));
    const fromY = Math.max(-maxY, Math.min(maxY, rows * font.height + (continuing ? previous.offsetY : 0)));
    if (!fromX && !fromY) return;
    return {
      region, fromX, fromY, offsetX: fromX, offsetY: fromY,
      start: continuing ? previous.frameTime ?? previous.start : performance.now(),
    };
  }

  private scrollFrame(time: number) {
    const { animation, font } = this;
    if (!animation) return;
    const remaining = Math.max(0, 1 - Math.max(0, time - animation.start) / scrollDuration);
    const dx = Math.round(animation.fromX * remaining ** 2);
    const dy = Math.round(animation.fromY * remaining ** 2);
    if (!dx && !dy) return;
    animation.offsetX = dx;
    animation.offsetY = dy;
    animation.frameTime = time;
    const { x, y, width, height } = animation.region;
    return {
      region: { x: x * font.width, y: y * font.height, width: width * font.width, height: height * font.height },
      dx, dy, fromX: animation.fromX, fromY: animation.fromY,
    };
  }

  private scrollPixels(scroll: IScroll) {
    const { font } = this;
    const { x, y, width, height, rows, cols } = scroll;
    const deltaX = cols * font.width;
    const deltaY = rows * font.height;
    const copyWidth = (width - Math.abs(cols)) * font.width;
    const copyHeight = (height - Math.abs(rows)) * font.height;
    if (copyWidth <= 0 || copyHeight <= 0) return;
    const source: Area = {
      x: x * font.width + Math.max(0, deltaX),
      y: y * font.height + Math.max(0, deltaY),
      width: copyWidth, height: copyHeight,
    };
    this.failed = !this.copyPixels(source, source.x - deltaX, source.y - deltaY);
  }

  private scrollLinks({ x, y, width, height, rows, cols }: IScroll) {
    const contains = (row: number, col: number) => row >= y && row < y + height && col >= x && col < x + width;
    const links = new Map<string, string>();
    for (const [key, hl] of this.links) {
      const [row, col] = key.split(",").map(Number);
      if (!contains(row, col)) links.set(key, hl);
      else if (contains(row - rows, col - cols)) links.set(`${row - rows},${col - cols}`, hl);
    }
    this.links = links;
  }

  dispose?(): void;
}
