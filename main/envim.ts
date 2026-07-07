import * as Electron from "electron";

import { ISetting } from "common/interface";

import { Emit } from "main/emit";
import { Connection } from "main/connection";
import { Setting } from "main/setting";

export class Envim {
  constructor() {
    Emit.on("envim:init", this.onInit);
    Emit.on("envim:connect", this.onConnect);
    Emit.on("envim:setting", this.onSetting);
    Emit.on("envim:api", this.onApi);
    Emit.on("envim:function", this.onFunction);
    Emit.on("envim:readline", this.onReadline);
    Emit.on("envim:command", this.onCommand);
    Emit.on("envim:theme", this.onTheme);
    Emit.on("envim:browser", this.onBrowser);
    Emit.on("envim:native:theme", this.onNativeTheme);
    process.on("uncaughtException", this.onError);
    process.on("unhandledRejection", this.onError);
    Electron.nativeTheme.on("updated", this.onNativeTheme);
  }

  private onInit = () => {
    const setting = Setting.get();

    setting && Emit.send("envim:setting", setting);
  }

  private onConnect = (setting: ISetting, bookmark: string) => {
    Connection.connect(setting, bookmark);
  }

  private onSetting = (setting: ISetting) => {
    Setting.set(setting);
  }

  private onApi = async (fname: string, args: any[]) => {
    return await Connection.active()?.emit.share("envim:api", fname, args);
  }

  private onFunction = async (name: string, args: any[]) => {
    return await Connection.active()?.emit.share("envim:function", name, args);
  }

  private onReadline = async (prompt: string, value?: string) => {
    return await Connection.active()?.emit.share("envim:readline", prompt, value);
  }

  private onCommand = async (command: string) => {
    return await Connection.active()?.emit.share("envim:command", command);
  }

  private onError = (e: Error | any) => {
    if (e instanceof Error) {
      Electron.dialog.showErrorBox("Error", `${e.message}\n${e.stack || ""}`);
    } else if (e instanceof String) {
      Electron.dialog.showErrorBox("Error", e.toString());
    }
    Connection.disconnect();
  }

  private onTheme = (theme?: "dark" | "light") => {
    if (!theme) {
      theme = Electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }

    Electron.nativeTheme.themeSource = theme;
    Emit.update("app:theme", false, theme);

    return theme;
  }

  private onBrowser = (url: string) => {
    return Connection.active()?.emit.share("envim:browser", url);
  }

  private onNativeTheme = () => {
    const theme = this.onTheme();

    setTimeout(() => {
      Emit.share("envim:command", `set background=${theme}`);
    }, 200);
  }
}
