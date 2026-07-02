import { NeovimClient } from "neovim";
import { UiAttachOptions } from "neovim/lib/api/Neovim";
import { readFile } from "fs/promises";
import { join } from "path";

import { WorkspaceEmit } from "main/emit";
import { Acp } from "main/envim/acp";
import { App } from "main/envim/app";
import { Autocmd } from "main/envim/autocmd";
import { Clipboard } from "main/envim/clipboard";
import { Function } from "main/envim/function";
import { Grids } from "main/envim/grid";
import { Highlights } from "main/envim/highlight";
import { McpGateway } from "main/mcp/gateway";

export class Workspace {
  public readonly emit: WorkspaceEmit;
  public readonly highlights: Highlights;
  public readonly grids: Grids;
  public readonly acp: Acp;
  public readonly autocmd: Autocmd;
  public readonly clipboard: Clipboard;
  public readonly function: Function;
  public readonly mcpGateway: McpGateway;
  public readonly app: App;

  constructor(
    public readonly nvim: NeovimClient,
    public readonly bookmark: string,
  ) {
    const emit = new WorkspaceEmit(this.bookmark);

    emit.on("envim:attach", this.onAttach);
    emit.on("envim:resize", this.onResize);
    emit.on("envim:position", this.onPosition);
    emit.on("envim:option", this.onOption);
    emit.on("envim:api", this.onApi);
    emit.on("envim:mouse", this.onMouse);
    emit.on("envim:input", this.onInput);
    emit.on("envim:command", this.onCommand);
    emit.on("envim:readline", this.onReadline);
    emit.on("envim:luafile", this.onLuafile);
    emit.on("envim:ready", this.onReady);
    emit.on("envim:resized", this.onResized);
    emit.on("envim:browser", this.onBrowser);
    emit.on("envim:webview", this.onWebview);
    emit.on("envim:function", this.onFunction);

    this.emit = emit;
    this.app = new App(this);
    this.autocmd = new Autocmd(this);
    this.clipboard = new Clipboard(this);
    this.function = new Function(this);
    this.highlights = new Highlights();
    this.grids = new Grids(this);
    this.acp = new Acp(this);
    this.mcpGateway = new McpGateway(this);
  }

  private onAttach = async (width: number, height: number, options: UiAttachOptions) => {
    await this.nvim.uiAttach(width, height, { ...{ ext_linegrid: true }, ...options });
    await this.nvim.command("doautocmd envim DirChanged");
  }

  private onResize = (gid: number, width: number, height: number) => {
    gid
      ? this.nvim.uiTryResizeGrid(gid, width, height).catch(() => this.grids.setStatus(gid, "delete", true))
      : this.nvim.uiTryResize(width, height);
  }

  private onPosition = (gid: number, x: number, y: number) => {
    this.grids.get(gid).setInfo({ x, y });
    this.grids.setStatus(gid, "show", true);
    this.grids.flush();
  }

  private onOption = async (name: string, value: boolean) => {
    return await this.nvim.uiSetOption(name, value);
  }

  private onApi = async (fname: string, args: any[]) => {
    return await this.nvim.request(fname, args);
  }

  private onMouse = async (gid: number, button: string, action: string, modifier: string, row: number, col: number) => {
    return await this.nvim.inputMouse(button, action, modifier, gid, row, col);
  }

  private onInput =  async(input: string) => {
    return await this.nvim.input(input);
  }

  private onCommand = async (command: string) => {
    return await this.nvim.command(command);
  }

  private onReadline = async (prompt: string, value: string = "") => {
    return await this.emit.share("envim:function", "EnvimInput", [prompt, value]);
  }

  private onLuafile = (path: string) => {
    readFile(join(__dirname, "../../lua", path), { encoding: "utf8" }).then(file => {
      this.nvim.lua(file);
    });
  }

  private onReady = (gid: number) => {
    this.onResized(gid);
  }

  private onResized = (gid: number) => {
    this.grids.get(gid).onReady();
    this.grids.flush();
  }

  private onBrowser = (src: string, command?: string) => {
    command = ["new", "vnew", "tabnew"].find(val => val === command) || "tabnew";
    const encoded = encodeURIComponent(src).replace(/%/g, "\\%");

    this.nvim.command(`${command} +setlocal\\ buftype=nofile\\ bufhidden=wipe\\ filetype=browser\\ nobuflisted envim-browser://${encoded}`);
  }

  private onWebview = (winid: number, active: boolean, src: string) => {
    const timer = setInterval(() => {
      const { gid } = this.grids.findByWinId(winid)?.getInfo() || {};

      if (gid) {
        this.emit.update(`webview:${gid}`, false, decodeURIComponent(src), active);
        clearInterval(timer);
      }
    }, 200);
  }

  private onFunction = (name: string, args: any[] = []) => {
    return this.nvim.request("nvim_call_function", [name, args]);
  }

  dispose() {
    this.emit.dispose();
    this.mcpGateway.dispose();
  }
}
