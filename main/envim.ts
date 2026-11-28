import * as Electron from "electron";

import { settingSchema } from "common/setting";
import { IFormRequest } from "common/schema";

import { Emit } from "main/emit";
import { Connection } from "main/connection";
import { Setting } from "main/setting";

export class Envim {
  private formId = 0;
  private forms = new Map<number, (result: unknown[]) => void>();
  private replies = new WeakSet<object>();

  constructor() {
    Emit.on("app:init", this.onAppInit);
    Emit.on("app:setting", this.onAppSetting);
    Emit.on("app:theme:native", this.onAppThemeNative);
    Emit.on("browser:open", this.onBrowserOpen);
    Emit.on("form:request", this.onFormRequest);
    Emit.on("neovim:api", this.onNeovimApi);
    Emit.on("neovim:command", this.onNeovimCommand);
    Emit.on("neovim:connect", this.onNeovimConnect);
    Emit.on("neovim:function", this.onNeovimFunction);
    Emit.on("neovim:theme", this.onNeovimTheme);
    process.on("uncaughtException", this.onError);
    process.on("unhandledRejection", this.onError);
    Electron.nativeTheme.on("updated", this.onAppThemeNative);
  }

  private onAppInit = () => {
    const setting = Setting.get();

    setting && Emit.send("app:setting", setting);
  }

  private onAppSetting = (input: unknown) => {
    return Setting.set(settingSchema.parse(input));
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

  private onNeovimApi = (fname: string, args: any[]) => {
    return Connection.active()?.emit.share("neovim:api", fname, args);
  }

  private onNeovimCommand = (command: string) => {
    return Connection.active()?.emit.share("neovim:command", command);
  }

  private onNeovimConnect = (input: unknown, bookmark: string) => {
    Connection.connect(settingSchema.parse(input), bookmark);
  }

  private onNeovimFunction = (name: string, args: any[]) => {
    return Connection.active()?.emit.share("neovim:function", name, args);
  }

  private onFormRequest = (request: Omit<IFormRequest, "reply">) => {
    const emit = Connection.active()?.emit;
    const id = ++this.formId;

    if (!emit) return Promise.resolve([]);

    if (!this.replies.has(emit)) {
      this.replies.add(emit);
      emit.on("form:reply", (id: number, ...result: unknown[]) => {
        this.forms.get(id)?.(result);
        this.forms.delete(id);
      });
    }

    return new Promise<unknown[]>(resolve => {
      this.forms.set(id, resolve);
      emit.send("form:open", { ...request, reply: { event: "form:reply", via: "send", args: [id] } } satisfies IFormRequest);
    });
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
