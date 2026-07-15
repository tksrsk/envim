import { ICell, IScroll } from "common/interface";

import { Context2D } from "renderer/utils/context2d";
import { Highlights } from "renderer/utils/highlight";

export class Canvas {
  private processing = false;
  private renderers: { [k: string]: Context2D } = {};

  constructor(private highlights: Highlights) {}

  create(
    id: number,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    lighten: boolean,
  ) {
    this.renderers[id] = new Context2D(canvas, ctx, lighten, this.highlights);
  }

  update(id: number, lighten: boolean) {
    this.renderers[id]?.update(lighten);
    this.render();
  }

  delete(id: number) {
    delete this.renderers[id];
    this.render();
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

  private render = () => {
    if (this.processing) return;

    const result: boolean[] = [];

    this.processing = true;
    Object.values(this.renderers).forEach((renderer) => result.push(renderer.render()));
    this.processing = false;
    result.some(r => r) && requestAnimationFrame(this.render);
  }
}
