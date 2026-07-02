import { Workspace } from "main/envim/workspace";

export class Function {
  constructor(private readonly workspace: Workspace) {
    this.workspace.emit.share("envim:luafile", "function.lua");
  }
}
