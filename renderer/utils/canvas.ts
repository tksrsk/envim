import { ICell, IScroll } from "common/interface";

import { Highlights } from "renderer/utils/highlight";

import type { Renderer } from "./renderer";
import { Context2D } from "./renderer/context2d";
import { WebGL2 } from "./renderer/webgl";

export class Canvas {
  private processing = false;
  private frame?: number;
  private renderers: { [k: string]: Renderer } = {};

  constructor(private highlights: Highlights) {}

  create(id: number, canvas: HTMLCanvasElement, lighten: boolean) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false });
    if (gl) {
      const webgl = WebGL2.create(canvas, gl, lighten, this.highlights);
      if (webgl) this.renderers[id] = webgl;
    } else {
      const context = canvas.getContext("2d");
      if (context) this.renderers[id] = new Context2D(context, lighten, this.highlights);
    }
  }

  update(id: number, lighten: boolean) {
    this.renderers[id]?.update(lighten);
    this.render();
  }

  delete(id: number) {
    this.renderers[id]?.dispose?.();
    delete this.renderers[id];
    if (!Object.keys(this.renderers).length) {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined;
    } else {
      this.render();
    }
  }

  clear(id: number, width: number, height: number) {
    this.renderers[id]?.clear(0, 0, width, height);
    this.render();
  }

  push(id: number, cells: ICell[], scroll: IScroll | undefined) {
    this.renderers[id]?.push(cells, scroll);
    this.render();
  }

  link(id: number, row: number, col: number) {
    return this.renderers[id]?.link(row, col);
  }

  private render = (time = performance.now()) => {
    if (this.processing) return;

    this.processing = true;
    let animating = false;
    try {
      for (const renderer of Object.values(this.renderers)) {
        if (renderer.render(time)) animating = true;
      }
    } finally {
      this.processing = false;
    }

    if (animating && this.frame === undefined) {
      this.frame = requestAnimationFrame(time => {
        this.frame = undefined;
        this.render(time);
      });
    }
  };
}
