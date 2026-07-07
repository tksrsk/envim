import { NeovimClient } from "neovim";
import { UiAttachOptions } from "neovim/lib/api/Neovim";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";

import { Setting } from "main/setting";
import { Emit, WorkspaceEmit } from "main/emit";
import { Acp } from "main/envim/acp";
import { App } from "main/envim/app";
import { Autocmd } from "main/envim/autocmd";
import { Clipboard } from "main/envim/clipboard";
import { Function } from "main/envim/function";
import { Grids } from "main/envim/grid";
import { Highlights } from "main/envim/highlight";
import { McpGateway } from "main/mcp/gateway";

export class Workspace {
  public readonly id = randomUUID();
  public readonly emit: WorkspaceEmit;
  public readonly highlights: Highlights;
  public readonly grids: Grids;
  public readonly acp: Acp;
  public readonly autocmd: Autocmd;
  public readonly clipboard: Clipboard;
  public readonly function: Function;
  public readonly mcpGateway: McpGateway;
  public readonly app: App;
  public cwd = "";

  constructor(
    public readonly nvim: NeovimClient,
    public bookmark: string,
  ) {
    const emit = new WorkspaceEmit(this.id);

    emit.on("browser:open", this.onBrowserOpen);
    emit.on("browser:view", this.onBrowserView);
    emit.on("neovim:api", this.onNeovimApi);
    emit.on("neovim:command", this.onNeovimCommand);
    emit.on("neovim:cwd", this.onNeovimCwd);
    emit.on("neovim:function", this.onNeovimFunction);
    emit.on("neovim:input", this.onNeovimInput);
    emit.on("neovim:luafile", this.onNeovimLuafile);
    emit.on("neovim:mouse", this.onNeovimMouse);
    emit.on("neovim:readline", this.onNeovimReadline);
    emit.on("neovim:ui:attach", this.onNeovimUiAttach);
    emit.on("neovim:ui:option", this.onNeovimUiOption);
    emit.on("neovim:ui:position", this.onNeovimUiPosition);
    emit.on("neovim:ui:ready", this.onNeovimUiReady);
    emit.on("neovim:ui:resize", this.onNeovimUiResize);
    emit.on("neovim:ui:resized", this.onNeovimUiResized);

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

  private onBrowserOpen = (src: string, command?: string) => {
    command = ["new", "vnew", "tabnew"].find(val => val === command) || "tabnew";
    const encoded = encodeURIComponent(src).replace(/%/g, "\\%");

    this.nvim.command(`${command} +setlocal\\ buftype=nofile\\ bufhidden=wipe\\ filetype=browser\\ nobuflisted envim-browser://${encoded}`);
  }

  private onBrowserView = (winid: number, active: boolean, src: string) => {
    const timer = setInterval(() => {
      const { gid } = this.grids.findByWinId(winid)?.getInfo() || {};

      if (gid) {
        this.emit.update(`browser:view:${gid}`, false, decodeURIComponent(src), active);
        clearInterval(timer);
      }
    }, 200);
  }

  private onNeovimApi = async (fname: string, args: any[]) => {
    return await this.nvim.request(fname, args);
  }

  private onNeovimCommand = async (command: string) => {
    return await this.nvim.command(command);
  }

  private onNeovimCwd = (cwd: string) => {
    const setting = Setting.get();
    const selected = setting?.bookmarks.findLast(({ path }) => cwd === path || cwd.indexOf(`${path}/`) === 0);

    this.cwd = cwd;

    if (selected && selected.path !== this.bookmark) Emit.share("neovim:connect", setting, selected.path);
  }

  private onNeovimFunction = (name: string, args: any[] = []) => {
    return this.nvim.request("nvim_call_function", [name, args]);
  }

  private onNeovimInput =  async(input: string) => {
    return await this.nvim.input(input);
  }

  private onNeovimLuafile = (path: string) => {
    readFile(join(__dirname, "../../lua", path), { encoding: "utf8" }).then(file => {
      this.nvim.lua(file);
    });
  }

  private onNeovimMouse = async (gid: number, button: string, action: string, modifier: string, row: number, col: number) => {
    return await this.nvim.inputMouse(button, action, modifier, gid, row, col);
  }

  private onNeovimReadline = async (prompt: string, value: string = "") => {
    return await this.emit.share("neovim:function", "EnvimInput", [prompt, value]);
  }

  private onNeovimUiAttach = async (width: number, height: number, options: UiAttachOptions) => {
    await this.nvim.uiAttach(width, height, { ...{ ext_linegrid: true }, ...options });
    await this.nvim.command("doautocmd envim DirChanged");
  }

  private onNeovimUiOption = async (name: string, value: boolean) => {
    return await this.nvim.uiSetOption(name, value);
  }

  private onNeovimUiPosition = (gid: number, x: number, y: number) => {
    this.grids.get(gid).setInfo({ x, y });
    this.grids.setStatus(gid, "show", true);
    this.grids.flush();
  }

  private onNeovimUiReady = (gid: number) => {
    this.onNeovimUiResized(gid);
  }

  private onNeovimUiResize = (gid: number, width: number, height: number) => {
    gid
      ? this.nvim.uiTryResizeGrid(gid, width, height).catch(() => this.grids.setStatus(gid, "delete", true))
      : this.nvim.uiTryResize(width, height);
  }

  private onNeovimUiResized = (gid: number) => {
    this.grids.get(gid).onReady();
    this.grids.flush();
  }

  dispose() {
    this.emit.dispose();
    this.mcpGateway.dispose();
  }
}
