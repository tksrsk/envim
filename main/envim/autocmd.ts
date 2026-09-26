import { Workspace } from "main/envim/workspace";

export class Autocmd {
  constructor(private readonly workspace: Workspace) {
    this.workspace.emit.share("neovim:luafile", "autocmd.lua");
  }
}
