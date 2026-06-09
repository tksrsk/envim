import { Emit } from "main/emit";

export class Autocmd {
  static setup() {
    Emit.share("envim:luafile", "autocmd.lua");
  }

  static dirchanged(cwd: string) {
    Emit.share("envim:cwd", cwd);
    Emit.send("envim:cwd", cwd);
  }
}
