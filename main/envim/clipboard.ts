import * as Electron from "electron";
import { Response } from "neovim/lib/host";
import { Workspace } from "main/envim/workspace";

export class Clipboard {
  private lines: string[] = [];
  private type: "v" | "V" | "b" = "v";

  constructor(private readonly workspace: Workspace) {
    this.workspace.emit.share("neovim:luafile", "clipboard.lua");
  }

  async copy(lines: string[], type: "v" | "V" | "b") {
    this.lines = lines;
    this.type = type;
    await Electron.clipboard.writeText(lines.join("\n"));
  }

  async paste(res: Response) {
    const text = await Electron.clipboard.readText();
    const lines = text.split("\n");
    if (this.lines && this.lines.join("\n") === text) {
      res.send([this.lines, this.type]);
    } else {
      res.send([lines, lines.length > 1 ? "V" : "v"]);
    }
  }
}
