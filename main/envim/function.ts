import { Emit } from "main/emit";

export class Function {
  static setup() {
    Emit.share("envim:luafile", "function.lua");
  }
}
