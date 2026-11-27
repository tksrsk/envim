import type { ICell } from "common/interface";

import { Renderer, type Area, type DecorationStroke } from ".";
import type { Highlights } from "../highlight";

interface BackgroundRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface Glyph {
  text: string;
  font: string;
  color: string;
  x: number;
  y: number;
}

interface AtlasEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

const vertexSource = `#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in vec2 atlasPosition;
layout(location = 2) in vec4 backgroundColor;
uniform vec2 viewportSize;
out vec2 uv;
out vec4 fillColor;
void main() {
  vec2 clip = position / viewportSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = atlasPosition;
  fillColor = backgroundColor;
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D atlas;
in vec2 uv;
in vec4 fillColor;
out vec4 color;
void main() {
  color = uv.x < 0.0 ? fillColor : texture(atlas, uv);
}`;

function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  if (!program) return null;

  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
    const shader = gl.createShader(type);
    if (!shader) {
      gl.deleteProgram(program);
      return null;
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }

  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;

  gl.deleteProgram(program);
  return null;
}

interface Surface {
  buffer: WebGLRenderbuffer;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export class WebGL2 extends Renderer {
  static create(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    lighten: boolean,
    highlights: Highlights,
  ) {
    const raster = document.createElement("canvas").getContext("2d");
    if (!raster || gl.isContextLost()) return null;

    const program = createProgram(gl);
    const texture = gl.createTexture();
    const buffer = gl.createBuffer();
    const viewportSize = program && gl.getUniformLocation(program, "viewportSize");
    if (!program || !texture || !buffer || !viewportSize) {
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      return null;
    }

    const maxSize: number = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const size = Math.min(2048, maxSize);
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const renderer = new WebGL2(canvas, raster, gl, program, texture, buffer, viewportSize, size, maxSize, lighten, highlights);
    if (gl.getError() === gl.NO_ERROR && renderer.resize(renderer.backgroundColor("0"))) return renderer;

    renderer.dispose();
    return null;
  }

  private grid?: Surface;
  private frame?: Surface;
  private capture?: Surface;
  private scratch?: Surface;

  private entries = new Map<string, AtlasEntry>();
  private nextX = 0;
  private nextY = 0;
  private shelfHeight = 0;

  private constructor(
    canvas: HTMLCanvasElement,
    private readonly raster: CanvasRenderingContext2D,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly texture: WebGLTexture,
    private readonly buffer: WebGLBuffer,
    private readonly viewportSize: WebGLUniformLocation,
    private readonly size: number,
    private readonly maxSize: number,
    lighten: boolean,
    highlights: Highlights,
  ) {
    super(canvas, lighten, highlights);
    document.fonts.addEventListener("loadingdone", this.reset);
    document.fonts.addEventListener("loadingerror", this.reset);
  }

  protected drawBackground(rect: Area, color: string) {
    return this.drawBackgrounds([{ ...rect, color }]);
  }

  protected get available() {
    return super.available && !this.gl.isContextLost();
  }

  protected drawCells(cells: ICell[]) {
    const backgrounds: BackgroundRect[] = [];
    const colors = new Map<string, string>();
    let previous: BackgroundRect | undefined;
    let previousRow = -1;
    let endColumn = -1;
    for (const cell of cells) {
      const { row, col, width, hl } = cell;
      let color = colors.get(hl);
      if (color === undefined) {
        color = this.backgroundColor(hl);
        colors.set(hl, color);
      }
      if (previous && row === previousRow && col === endColumn && previous.color === color) {
        previous.width = (col + width) * this.font.width - previous.x;
      } else {
        previous = {
          x: col * this.font.width,
          y: row * this.font.height,
          width: width * this.font.width,
          height: this.font.height,
          color,
        };
        backgrounds.push(previous);
      }
      previousRow = row;
      endColumn = col + width;
    }
    const strokes = this.decorations(cells);
    const glyphs = this.glyphs(cells);
    return this.drawBackgrounds(backgrounds) && this.draw(glyphs, strokes);
  }

  private glyphs(cells: ICell[]) {
    const layers: Glyph[][] = [[], [], [], []];

    for (const { row, col, text, hl } of cells) {
      if (!text || text === " ") continue;

      const layer = ((row % 2 ? 0 : 2) + col) % 4;
      layers[layer].push({
        text,
        x: col * this.font.width,
        y: row * this.font.height,
        font: this.highlights.font(hl, this.font.size) || this.highlights.font("0", this.font.size) || `${this.font.size}px monospace`,
        color: this.highlights.color(hl, "foreground", { lighten: this.lighten }) || "#000000",
      });
    }

    return layers.flat();
  }

  private reset = () => {
    this.entries.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.shelfHeight = 0;
  };

  private rasterize(glyph: Glyph, phaseX: number, phaseY: number) {
    const { font: metrics, raster } = this;
    const baseline = phaseY + (metrics.height - metrics.size) / 2;
    raster.font = glyph.font;
    raster.textBaseline = "top";
    raster.textAlign = "left";
    const bounds = raster.measureText(glyph.text);
    const left = Math.floor(phaseX - bounds.actualBoundingBoxLeft) - 1;
    const top = Math.floor(baseline - bounds.actualBoundingBoxAscent) - 1;
    const width = Math.ceil(phaseX + bounds.actualBoundingBoxRight) + 1 - left;
    const height = Math.ceil(baseline + bounds.actualBoundingBoxDescent) + 1 - top;
    if (!(width > 0 && height > 0 && width <= this.size && height <= this.size)) return;

    if (raster.canvas.width !== width) raster.canvas.width = width;
    if (raster.canvas.height !== height) raster.canvas.height = height;
    raster.clearRect(0, 0, width, height);
    raster.font = glyph.font;
    raster.fillStyle = glyph.color;
    raster.textBaseline = "top";
    raster.textAlign = "left";

    const x = phaseX - left;
    const y = phaseY - top;
    raster.fillText(glyph.text, x, baseline - top);
    // Match the grid's Canvas 2D glyph clipping, including rightward overhang.
    raster.clearRect(x - metrics.width, y - 1, metrics.width, metrics.height + 2);
    raster.clearRect(x - 1, y - metrics.height, metrics.width + 2, metrics.height);
    raster.clearRect(x - 1, y + metrics.height, metrics.width + 2, metrics.height);
    return { width, height, left, top };
  }

  private createSurface(width: number, height: number): Surface | undefined {
    const { gl } = this;
    const buffer = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (buffer && framebuffer) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, buffer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { buffer, framebuffer, width, height };
      }
    }
    gl.deleteFramebuffer(framebuffer);
    gl.deleteRenderbuffer(buffer);
    return undefined;
  }

  private deleteSurface(surface?: Surface) {
    if (!surface) return;
    this.gl.deleteFramebuffer(surface.framebuffer);
    this.gl.deleteRenderbuffer(surface.buffer);
  }

  private blit(source: Surface, target: Surface | undefined, area: Area, x = area.x, y = area.y) {
    const { gl } = this;
    const { width, height } = area;
    const sourceY = source.height - area.y;
    const targetY = (target?.height ?? gl.drawingBufferHeight) - y;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target?.framebuffer ?? null);
    gl.blitFramebuffer(area.x, sourceY - height, area.x + width, sourceY,
      x, targetY - height, x + width, targetY, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  protected resize(color: string) {
    const { canvas, gl } = this;
    const { width, height } = canvas;
    if (!this.available || width > this.maxSize || height > this.maxSize) return false;
    if (!width || !height) return true;
    if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) return false;
    if (this.grid?.width === width && this.grid.height === height) return true;

    const grid = this.createSurface(width, height);
    if (!grid) return false;
    const old = this.grid;
    this.grid = grid;
    this.deleteSurface(this.frame);
    this.deleteSurface(this.capture);
    this.deleteSurface(this.scratch);
    this.frame = this.capture = this.scratch = undefined;
    const filled = this.drawBackgrounds([{ x: 0, y: 0, width, height, color }]);
    if (old) {
      this.blit(old, grid, { x: 0, y: 0, width: Math.min(width, old.width), height: Math.min(height, old.height) });
      this.deleteSurface(old);
    }
    return filled && gl.getError() === gl.NO_ERROR;
  }

  protected captureFrame() {
    [this.frame, this.capture] = [this.capture, this.frame];
  }

  protected copyPixels(area: Area, x: number, y: number) {
    const { grid } = this;
    if (!grid || !this.available) return false;
    const source = { x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height) };
    if (!source.width || !source.height) return true;
    if (!this.scratch || source.width > this.scratch.width || source.height > this.scratch.height) {
      const width = Math.max(source.width, this.scratch?.width ?? 0);
      const height = Math.max(source.height, this.scratch?.height ?? 0);
      this.deleteSurface(this.scratch);
      this.scratch = this.createSurface(width, height);
    }
    if (!this.scratch) return false;
    this.blit(grid, this.scratch, source, 0, 0);
    this.blit(this.scratch, grid, { ...source, x: 0, y: 0 }, Math.round(x), Math.round(y));
    return this.available;
  }

  protected present(region?: Area, dx = 0, dy = 0, fromX = 0, fromY = 0) {
    const { gl, grid, capture, canvas } = this;
    if (!canvas.width || !canvas.height) return this.available;
    if (!grid || !this.available) return false;
    const full = { x: 0, y: 0, width: grid.width, height: grid.height };
    if (!this.frame) this.frame = this.createSurface(grid.width, grid.height);
    const frame = this.frame;
    if (!frame) return false;
    this.blit(grid, frame, full);
    if (region && capture) {
      const x = Math.round(region.x);
      const y = Math.round(region.y);
      const width = Math.round(region.x + region.width) - x;
      const height = Math.round(region.y + region.height) - y;
      const area = { x, y, width, height };
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, grid.height - y - height, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.blit(capture, frame, area, x + dx - Math.round(fromX), y + dy - Math.round(fromY));
      // Blitting replaces the destination, including transparent cell pixels.
      this.blit(grid, frame, area, x + dx, y + dy);
      gl.disable(gl.SCISSOR_TEST);
    }
    this.blit(frame, undefined, full);
    // Check queued cell draws, scroll copies, and presentation together.
    return gl.getError() === gl.NO_ERROR && this.available;
  }

  private beginDraw() {
    const { gl, grid } = this;
    if (!grid || !this.available) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, grid.framebuffer);
    gl.viewport(0, 0, grid.width, grid.height);
    gl.uniform2f(this.viewportSize, grid.width, grid.height);
    return true;
  }

  private drawBackgrounds(rects: BackgroundRect[]) {
    if (!rects.length || !this.canvas.width || !this.canvas.height) return true;

    const vertices: number[] = [];
    const colors = new Map<string, number[]>();
    for (const rect of rects) {
      const { color } = rect;
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      const right = Math.round(rect.x + rect.width);
      const bottom = Math.round(rect.y + rect.height);
      const rgba = this.solidColor(color, colors);
      if (!rgba) return false;
      vertices.push(x, y, ...rgba, right, y, ...rgba, x, bottom, ...rgba,
        x, bottom, ...rgba, right, y, ...rgba, right, bottom, ...rgba);
    }

    if (!this.beginDraw()) return false;
    const { gl } = this;
    gl.disable(gl.BLEND);
    this.drawSolid(vertices);
    gl.enable(gl.BLEND);
    return this.available;
  }

  private solidColor(color: string, colors: Map<string, number[]>) {
    const cached = colors.get(color);
    if (cached) return cached;

    const rgb = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
    const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
    if (!color) return [0, 0, 0, 1];
    if (!rgb && !rgba) return;
    const alpha = rgba ? Math.min(1, +rgba[4]) : 1;
    const channels = rgba ? rgba.slice(1, 4).map(Number) : rgb!.slice(1).map(channel => parseInt(channel, 16));
    const result = [...channels.map(channel => channel * alpha / 255), alpha];
    colors.set(color, result);
    return result;
  }

  private drawSolid(vertices: number[]) {
    if (!vertices.length) return;

    const { gl } = this;
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib2f(1, -1, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 24, 8);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
  }

  private decorationVertices(strokes: DecorationStroke[]) {
    const vertices: number[] = [];
    const colors = new Map<string, number[]>();
    for (const { points, width, color } of strokes) {
      const rgba = this.solidColor(color, colors);
      if (!rgba) return;

      // Share the edges at each join so translucent strokes do not overlap themselves.
      const edges = points.map((point, index) => {
        const normal = (from: typeof point, to: typeof point) => {
          const x = to.x - from.x;
          const y = to.y - from.y;
          const length = Math.hypot(x, y);
          return { x: -y / length, y: x / length };
        };
        const before = index ? normal(points[index - 1], point) : normal(point, points[1]);
        const after = index + 1 < points.length ? normal(point, points[index + 1]) : before;
        const scale = width / Math.max(1, 2 * (1 + before.x * after.x + before.y * after.y));
        const x = (before.x + after.x) * scale;
        const y = (before.y + after.y) * scale;
        return [[point.x + x, point.y + y, ...rgba], [point.x - x, point.y - y, ...rgba]];
      });
      for (let i = 1; i < edges.length; i++) {
        const [a, b] = edges[i - 1];
        const [c, d] = edges[i];
        vertices.push(...a, ...b, ...c, ...c, ...b, ...d);
      }
    }
    return vertices;
  }

  private draw(glyphs: Glyph[], strokes: DecorationStroke[]) {
    if ((!glyphs.length && !strokes.length) || !this.canvas.width || !this.canvas.height) return true;
    const decorations = this.decorationVertices(strokes);
    if (!decorations || glyphs.some(glyph => !glyph.font || !glyph.color) || !this.beginDraw()) return false;

    const { gl, size, font: metrics } = this;
    this.drawSolid(decorations);
    gl.enableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    const vertices: number[] = [];
    const drawBatch = () => {
      if (!vertices.length) return;

      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 4);
      vertices.length = 0;
    };

    for (const glyph of glyphs) {
      // Keep the fractional placement in the cache key at the rasterizer's subpixel precision.
      const pixelX = Math.round(glyph.x * 64) / 64;
      const pixelY = Math.round(glyph.y * 64) / 64;
      const floorX = Math.floor(pixelX);
      const floorY = Math.floor(pixelY);
      const phaseX = pixelX - floorX;
      const phaseY = pixelY - floorY;
      const key = JSON.stringify([glyph.text, glyph.font, glyph.color, metrics.size, metrics.width, metrics.height, phaseX, phaseY]);
      let entry = this.entries.get(key);

      if (!entry) {
        const bitmap = this.rasterize(glyph, phaseX, phaseY);
        if (!bitmap) return false;

        if (this.nextX + bitmap.width > size) {
          this.nextX = 0;
          this.nextY += this.shelfHeight;
          this.shelfHeight = 0;
        }
        if (this.nextY + bitmap.height > size) {
          drawBatch();
          this.reset();
        }

        entry = { ...bitmap, x: this.nextX, y: this.nextY };
        gl.texSubImage2D(gl.TEXTURE_2D, 0, entry.x, entry.y, gl.RGBA, gl.UNSIGNED_BYTE, this.raster.canvas);
        this.entries.set(key, entry);
        this.nextX += entry.width;
        this.shelfHeight = Math.max(this.shelfHeight, entry.height);
      }

      const x0 = floorX + entry.left;
      const y0 = floorY + entry.top;
      const x1 = x0 + entry.width;
      const y1 = y0 + entry.height;
      const u0 = entry.x / size;
      const v0 = entry.y / size;
      const u1 = (entry.x + entry.width) / size;
      const v1 = (entry.y + entry.height) / size;
      vertices.push(x0, y0, u0, v0, x1, y0, u1, v0, x0, y1, u0, v1,
        x0, y1, u0, v1, x1, y0, u1, v0, x1, y1, u1, v1);
    }

    drawBatch();
    return this.available;
  }

  dispose() {
    document.fonts.removeEventListener("loadingdone", this.reset);
    document.fonts.removeEventListener("loadingerror", this.reset);
    this.deleteSurface(this.grid);
    this.deleteSurface(this.frame);
    this.deleteSurface(this.capture);
    this.deleteSurface(this.scratch);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
