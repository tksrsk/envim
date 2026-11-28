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
import { Messages } from "main/envim/message";
import { Highlights } from "main/envim/highlight";
import { BrowserTabs } from "main/browser/tabs";
import { BrowserServer } from "main/browser/mcp/server";
import { McpGateway } from "main/mcp/gateway";

export class Workspace {
  public readonly id = randomUUID();
  public readonly emit: WorkspaceEmit;
  public readonly highlights: Highlights;
  public readonly grids: Grids;
  public readonly messages: Messages;
  public readonly acp: Acp;
  public readonly autocmd: Autocmd;
  public readonly clipboard: Clipboard;
  public readonly function: Function;
  public readonly mcpGateway: McpGateway;
  public readonly browser: BrowserServer;
  public readonly browserTabs: BrowserTabs;
  public readonly app: App;
  public cwd = "";

  constructor(
    public readonly nvim: NeovimClient,
    public bookmark: string,
  ) {
    const emit = new WorkspaceEmit(this.id);

    emit.on("browser:open", this.onBrowserOpen);
    emit.on("neovim:api", this.onNeovimApi);
    emit.on("neovim:command", this.onNeovimCommand);
    emit.on("neovim:cwd", this.onNeovimCwd);
    emit.on("neovim:function", this.onNeovimFunction);
    emit.on("neovim:input", this.onNeovimInput);
    emit.on("neovim:luafile", this.onNeovimLuafile);
    emit.on("neovim:mouse", this.onNeovimMouse);
    emit.on("neovim:ui:attach", this.onNeovimUiAttach);
    emit.on("neovim:ui:option", this.onNeovimUiOption);
    emit.on("neovim:ui:position", this.onNeovimUiPosition);
    emit.on("neovim:ui:ready", this.onNeovimUiReady);
    emit.on("neovim:ui:resize", this.onNeovimUiResize);
    emit.on("neovim:ui:resized", this.onNeovimUiResized);

    this.emit = emit;
    this.messages = new Messages(this);
    this.app = new App(this);
    this.autocmd = new Autocmd(this);
    this.clipboard = new Clipboard(this);
    this.function = new Function(this);
    this.highlights = new Highlights();
    this.grids = new Grids(this);
    this.acp = new Acp(this);
    this.mcpGateway = new McpGateway(this);
    this.browserTabs = new BrowserTabs(this.id, emit);
    this.browser = new BrowserServer(this);
  }

  private onBrowserOpen = async (url: string) => { await this.browserTabs.open(url); };

  private onNeovimApi = (fname: string, args: any[]) => {
    return this.nvim.request(fname, args);
  }

  private onNeovimCommand = (command: string) => {
    return this.nvim.command(command);
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

  private onNeovimInput = (input: string) => {
    return this.nvim.input(input);
  }

  private onNeovimLuafile = (path: string) => {
    readFile(join(__dirname, "../../lua", path), { encoding: "utf8" }).then(file => {
      this.nvim.lua(file);
    });
  }

  private onNeovimMouse = (gid: number, button: string, action: string, modifier: string, row: number, col: number) => {
    return this.nvim.inputMouse(button, action, modifier, gid, row, col);
  }

  private onNeovimUiAttach = async (width: number, height: number, options: UiAttachOptions) => {
    await this.nvim.uiAttach(width, height, { ...{ ext_linegrid: true }, ...options });
  }

  private onNeovimUiOption = (name: string, value: boolean) => {
    return this.nvim.uiSetOption(name, value);
  }

  private onNeovimUiPosition = (gid: number, x: number, y: number) => {
    this.grids.get(gid).setInfo({ x, y });
    this.grids.setStatus(gid, "show", true);
    this.grids.flush();
  }

  private onNeovimUiReady = (gid: number, revision: number) => {
    this.onNeovimUiResized(gid, revision);
  }

  private onNeovimUiResize = (gid: number, width: number, height: number) => {
    gid
      ? this.nvim.uiTryResizeGrid(gid, width, height).catch(() => this.grids.setStatus(gid, "delete", true))
      : this.nvim.uiTryResize(width, height);
  }

  private onNeovimUiResized = (gid: number, revision: number) => {
    this.grids.onReady(gid, revision);
  }

  dispose() {
    this.emit.dispose();
    this.browser.dispose();
    this.browserTabs.dispose();
    this.mcpGateway.dispose();
  }
}
