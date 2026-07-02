import { Workspace } from "main/envim/workspace";

export class Autocmd {
  constructor(private readonly workspace: Workspace) {
    this.workspace.emit.share("envim:luafile", "autocmd.lua");
  }

  dirchanged(cwd: string) {
    this.workspace.emit.share("envim:cwd", cwd);
    this.workspace.emit.send("envim:cwd", cwd);
  }
}
