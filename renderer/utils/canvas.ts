import { ICell, IScroll } from "common/interface";

import { Context2D } from "./context2d";
import { Cache } from "./cache";

const TYPE = "renderer";

export class Canvas {
  private static processing = false;

  static create(
    id: string,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    lighten: boolean,
  ) {
    Cache.set<Context2D>(TYPE, id, new Context2D(canvas, ctx, lighten));
  }

  static update(id: string, lighten: boolean) {
    Cache.get<Context2D>(TYPE, id)?.update(lighten);
    Canvas.render();
  }

  static delete(id: string) {
    Cache.delete(TYPE, id);
    Canvas.render();
  }

  static clear(id: string, width: number, height: number) {
    Cache.get<Context2D>(TYPE, id)?.clear(0, 0, width, height);
    Canvas.render();
  }

  static push(id: string, cells: ICell[], scroll: IScroll | undefined) {
    Cache.get<Context2D>(TYPE, id)?.push(cells, scroll);
    Canvas.render();
  }

  static link(id: string, row: number, col: number) {
    return Cache.get<Context2D>(TYPE, id)?.link(row, col);
  }

  private static render() {
    if (Canvas.processing) return;

    const result: boolean[] = [];

    Canvas.processing = true;
    Cache.each<Context2D>(TYPE, (renderer) => result.push(renderer.render()));
    Canvas.processing = false;
    result.some(r => r) && requestAnimationFrame(Canvas.render);
  }
}
