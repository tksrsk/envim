import type { ICell } from "common/interface";

import { Renderer, type Area, type DecorationStroke } from ".";
import type { Highlights } from "../highlight";
import type { ISetting } from "common/setting";

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class Context2D extends Renderer {
  private backing: Surface;
  private textcanvases: Surface[] = [];
  private scrollCapture?: Surface;

  constructor(
    private readonly display: CanvasRenderingContext2D,
    lighten: boolean,
    highlights: Highlights,
    font: ISetting["font"],
  ) {
    super(display.canvas, lighten, highlights, font);
    this.backing = this.getCanvas();
    this.drawBackground({ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }, this.backgroundColor("0"));
  }

  protected drawBackground({ x, y, width, height }: Area, color: string) {
    this.paintBackground(x, y, width, height, color);
    return true;
  }

  private get bgctx() {
    return this.backing.ctx;
  }

  protected resize(color: string) {
    const { width, height } = this.canvas;
    const previous = this.backing.canvas;
    if (previous.width === width && previous.height === height) return true;

    const { ctx } = this.backing = this.getCanvas();
    const overlapWidth = Math.min(width, previous.width);
    const overlapHeight = Math.min(height, previous.height);
    if (overlapWidth < width) this.paintBackground(overlapWidth, 0, width - overlapWidth, overlapHeight, color);
    if (overlapHeight < height) this.paintBackground(0, overlapHeight, width, height - overlapHeight, color);
    if (overlapWidth && overlapHeight) ctx.drawImage(previous, 0, 0);
    this.textcanvases = [];
    this.scrollCapture = undefined;
    return true;
  }

  private getCanvas() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Failed create canvas");

    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    ctx.lineWidth = this.font.scale;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    return { canvas, ctx };
  }

  private drawDecorations(strokes: DecorationStroke[]) {
    const ctx = this.bgctx;
    for (const { points, color } of strokes) {
      if (ctx.strokeStyle !== color) ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const { x, y } of points.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  private paintBackground(x: number, y: number, width: number, height: number, color: string) {
    const ctx = this.bgctx;
    if (ctx.fillStyle !== color) ctx.fillStyle = color;
    ctx.clearRect(x, y, width, height);
    ctx.fillRect(x, y, width, height);
  }

  protected drawCells(cells: ICell[]) {
    const { width, height, size } = this.font;
    for (const { row, col, width: columns, hl } of cells) {
      this.paintBackground(col * width, row * height, columns * width, height, this.backgroundColor(hl));
    }
    this.drawDecorations(this.decorations(cells));
    if (!this.canvas.width || !this.canvas.height || !cells.some(cell => cell.text && cell.text !== " ")) return true;

    if (!this.textcanvases.length) {
      this.textcanvases = Array.from({ length: 4 }, () => this.getCanvas());
    }
    for (const { ctx, canvas } of this.textcanvases) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    for (const { row, col, hl, text } of cells) {
      if (!text || text === " ") continue;
      const x = col * width;
      const y = row * height;
      const ctx = this.textcanvases[((row % 2 ? 0 : 2) + col) % 4].ctx;
      const font = this.highlights.font(hl, size) || this.highlights.font("0", size) || `${size}px monospace`;
      const color = this.highlights.color(hl, "foreground", { lighten: this.lighten }) || "#000000";
      if (ctx.font !== font) ctx.font = font;
      if (ctx.fillStyle !== color) ctx.fillStyle = color;
      ctx.fillText(text, x, y + (height - size) / 2);
      ctx.clearRect(x - width, y - 1, width, height + 2);
      ctx.clearRect(x - 1, y - height, width + 2, height);
      ctx.clearRect(x - 1, y + height, width + 2, height);
    }

    for (const { canvas } of this.textcanvases) this.bgctx.drawImage(canvas, 0, 0);
    return true;
  }

  protected captureFrame() {
    const { ctx, canvas } = this.scrollCapture ??= this.getCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.canvas, 0, 0);
  }

  protected copyPixels({ x, y, width, height }: Area, destX: number, destY: number) {
    const ctx = this.bgctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(destX, destY, width, height);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(this.backing.canvas, x, y, width, height, destX, destY, width, height);
    ctx.restore();
    return true;
  }

  protected present(region?: Area, dx = 0, dy = 0, fromX = 0, fromY = 0) {
    const ctx = this.display;
    const { width, height } = ctx.canvas;
    if (!width || !height) return true;
    ctx.clearRect(0, 0, width, height);
    const backing = this.backing.canvas;
    ctx.drawImage(backing, 0, 0);
    if (region && this.scrollCapture) {
      const { x, y, width, height } = region;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.clearRect(x, y, width, height);
      ctx.drawImage(this.scrollCapture.canvas, x, y, width, height,
        x + dx - fromX, y + dy - fromY, width, height);
      ctx.clearRect(x + dx, y + dy, width, height);
      ctx.drawImage(backing, x, y, width, height, x + dx, y + dy, width, height);
      ctx.restore();
    }
    return true;
  }
}
