import { app, dialog, nativeTheme } from "electron";
import { join } from "path"
import { readFile, writeFile } from "fs/promises";
import { NeovimClient } from "neovim";
import { UiAttachOptions } from "neovim/lib/api/Neovim"

import { ISetting } from "common/interface";

import { Emit } from "./emit";
import { Connection } from "./connection";
import { Setting } from "./setting";
import { App } from "./envim/app";
import { Grids } from "./envim/grid";

export class Envim {
  private nvim = new NeovimClient;

  constructor() {
    Emit.on("envim:init", this.onInit);
    Emit.on("envim:connect", this.onConnect);
    Emit.on("envim:setting", this.onSetting);
    Emit.on("envim:attach", this.onAttach);
    Emit.on("envim:resize", this.onResize);
    Emit.on("envim:position", this.onPosition);
    Emit.on("envim:option", this.onOption);
    Emit.on("envim:api", this.onApi);
    Emit.on("envim:mouse", this.onMouse);
    Emit.on("envim:input", this.onInput);
    Emit.on("envim:readline", this.onReadline);
    Emit.on("envim:command", this.onCommand);
    Emit.on("envim:luafile", this.onLuafile);
    Emit.on("envim:ready", this.onReady);
    Emit.on("envim:resized", this.onResized);
    Emit.on("envim:theme", this.onTheme);
    Emit.on("envim:browser", this.onBrowser);
    Emit.on("envim:preview", this.onPreview);
    Emit.on("envim:preview:toggle", this.togglePreview);
    process.on("uncaughtException", this.onError);
    process.on("unhandledRejection", this.onError);
    nativeTheme.on("updated", this.handleTheme);
  }

  private onInit = () => {
    const setting = Setting.get();

    setting && Emit.send("envim:setting", setting);
  }

  private onConnect = (type: string, path: string, bookmark: string ) => {
    const error = () => {
      const setting = Setting.get();
      const message = `Connection error occurred : "[${type}]:${path}".\nDelete preset?`;

      if (!setting?.presets[`[${type}]:${path}`]) return false;
      if (dialog.showMessageBoxSync({ message, buttons: ["Yes", "No"], defaultId: 0 }) === 0) {
        Setting.remove(type, path);
        this.onInit();
      }
    }

    const connect = async (nvim: NeovimClient, init: boolean, workspace: string) => {
      this.nvim = nvim;
      new App(this.nvim, init, workspace);
      bookmark && this.onCommand(`cd ${bookmark}`);

      if (init) {
        this.nvim.setClientInfo("Envim", { major: 0, minor: 0, patch: 1, prerelease: "dev" }, "ui", {}, {})
        this.nvim.on("disconnect", () => this.onDisconnect(workspace));
        await this.nvim.setVar('envim_id', await this.nvim.channelId);
      }
      Emit.send("app:switch", true);

      this.handleTheme();
    };

    Connection.connect(type, path, bookmark, connect, error);
  }

  private onSetting = (setting: ISetting) => {
    Setting.set(setting);
  }

  private onAttach = async (width: number, height: number, options: UiAttachOptions) => {
    await this.nvim.uiAttach(width, height, { ...{ ext_linegrid: true }, ...options });
    await this.onCommand("doautocmd envim DirChanged");
    Emit.send("envim:connections", Connection.connections());
  }

  private onResize = (gid: number, width: number, height: number) => {
    gid
      ? this.nvim.uiTryResizeGrid(gid, width, height).catch(() => Grids.setStatus(gid, "delete", true))
      : this.nvim.uiTryResize(width, height);
  }

  private onPosition = (gid: number, x: number, y: number) => {
    Grids.get(gid).setInfo({ x, y });
    Grids.setStatus(gid, "show", true);
    Grids.flush();
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

  private onInput = async (input: string) => {
    return await this.nvim.input(input);
  }

  private onReadline = async (prompt: string, value: string = "") => {
    return await this.onApi("nvim_call_function", ["EnvimInput", [prompt, value]]);
  }

  private onCommand = async (command: string) => {
    return await this.nvim.command(command);
  }

  private onLuafile = (path: string) => {
    readFile(join(__dirname, "lua", path), { encoding: "utf8" }).then(file => {
      this.nvim.lua(file);
    });
  }

  private onReady = (gid: number) => {
    this.onResized(gid);
  }

  private onResized = (gid: number) => {
    Grids.get(gid).onReady();
    Grids.flush();
  }

  private onDisconnect = (workspace: string) => {
    Grids.disconnect();
    Connection.disconnect(workspace, (workspace?: { nvim: NeovimClient, bookmark: string, key: string }) => {
      const { type, path } = Setting.get();

      if (workspace) {
        this.onConnect(type, path, workspace.bookmark);
      } else {
        Emit.send("app:switch", false);
      }
    });
  }

  private onError = (e: Error | any) => {
    if (e instanceof Error) {
      dialog.showErrorBox('Error', `${e.message}\n${e.stack || ""}`);
    } else if (e instanceof String) {
      dialog.showErrorBox('Error', e.toString());
    }
    this.onDisconnect("");
  }

  private onTheme = (theme?: "dark" | "light") => {
    if (!theme) {
      theme = nativeTheme.shouldUseDarkColors ? "dark" : "light"
    }

    nativeTheme.themeSource = theme;
    Emit.update("app:theme", false, theme);

    return theme;
  }

  private onBrowser = (src: string, command?: string) => {
    command = ["new", "vnew", "tabnew"].find(val => val === command) || "tabnew";
    this.onCommand(`${command} +let\\ w:envim_browser_src="${encodeURIComponent(src)}" envim://browser`);
  }

  private onPreview = (content: any, ext: string) => {
    const path = join(app.getPath("userData"), `tmp.${ext}`);;
    const src = `file://${path}`;

    writeFile(path, Buffer.from(content)).then(() => this.onBrowser(src, "vnew"));
  }

  private togglePreview = (winid: number, active: boolean, src: string) => {
    const timer = setInterval(() => {
      const { id } = Grids.findByWinId(winid)?.getInfo() || {};

      if (id) {
        Emit.update(`preview:${id}`, false, decodeURIComponent(src), active);
        clearInterval(timer);
      }
    }, 200);
  }

  private handleTheme = () => {
    const theme = this.onTheme();

    setTimeout(() => {
      this.nvim.isApiReady && this.onCommand(`set background=${theme}`);
    }, 200);
  }
}
