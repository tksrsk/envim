import * as Electron from "electron";

import { ISetting } from "common/interface";

import { Emit } from "main/emit";
import { Connection } from "main/connection";
import { Setting } from "main/setting";

export class Envim {
  constructor() {
    Emit.on("app:init", this.onAppInit);
    Emit.on("app:setting", this.onAppSetting);
    Emit.on("app:theme:native", this.onAppThemeNative);
    Emit.on("browser:open", this.onBrowserOpen);
    Emit.on("neovim:api", this.onNeovimApi);
    Emit.on("neovim:command", this.onNeovimCommand);
    Emit.on("neovim:connect", this.onNeovimConnect);
    Emit.on("neovim:function", this.onNeovimFunction);
    Emit.on("neovim:readline", this.onNeovimReadline);
    Emit.on("neovim:theme", this.onNeovimTheme);
    process.on("uncaughtException", this.onError);
    process.on("unhandledRejection", this.onError);
    Electron.nativeTheme.on("updated", this.onAppThemeNative);
  }

  private onAppInit = () => {
    const setting = Setting.get();

    setting && Emit.send("app:setting", setting);
  }

  private onAppSetting = (setting: ISetting) => {
    Setting.set(setting);
  }

  private onAppThemeNative = () => {
    const theme = this.onNeovimTheme();

    setTimeout(() => {
      Emit.share("neovim:command", `set background=${theme}`);
    }, 200);
  }

  private onBrowserOpen = (url: string) => {
    return Connection.active()?.emit.share("browser:open", url);
  }

  private onNeovimApi = async (fname: string, args: any[]) => {
    return await Connection.active()?.emit.share("neovim:api", fname, args);
  }

  private onNeovimCommand = async (command: string) => {
    return await Connection.active()?.emit.share("neovim:command", command);
  }

  private onNeovimConnect = (setting: ISetting, bookmark: string) => {
    Connection.connect(setting, bookmark);
  }

  private onNeovimFunction = async (name: string, args: any[]) => {
    return await Connection.active()?.emit.share("neovim:function", name, args);
  }

  private onNeovimReadline = async (prompt: string, value?: string) => {
    return await Connection.active()?.emit.share("neovim:readline", prompt, value);
  }

  private onNeovimTheme = (theme?: "dark" | "light") => {
    if (!theme) {
      theme = Electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }

    Electron.nativeTheme.themeSource = theme;
    Emit.update("app:theme", false, theme);

    return theme;
  }

  private onError = (e: Error | any) => {
    if (e instanceof Error) {
      Electron.dialog.showErrorBox("Error", `${e.message}\n${e.stack || ""}`);
    } else if (e instanceof String) {
      Electron.dialog.showErrorBox("Error", e.toString());
    }
    Connection.disconnect();
  }
}
