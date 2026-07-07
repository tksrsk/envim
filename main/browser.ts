import * as Electron from "electron";
import { lookup } from "dns";

import { Bootstrap } from "main/bootstrap";
import { Emit } from "main/emit";

export class Browser {
  private ignoreCertErrorHost: string[] = [];
  private devtoolWindow?: Electron.BrowserWindow;
  private currentMode = "blur";

  constructor(private webContents: Electron.WebContents) {
    webContents.setWindowOpenHandler(this.onOpenWindow);
    webContents.on("devtools-open-url", this.onOpenUrl);
    webContents.on("login", this.onLogin);
    webContents.on("certificate-error", this.onCertError);
    webContents.on("will-prevent-unload", this.onUnload);
    webContents.on("context-menu", this.onContextMenu);
    webContents.on("before-input-event", this.onInput);
    webContents.on("destroyed", this.onDestroy);
    Emit.on(`browser:capture:${webContents.id}`, this.onBrowserCapture);
    Emit.on(`browser:devtool:${webContents.id}`, this.onBrowserDevtool);
    Emit.on(`browser:mode:${webContents.id}`, this.onBrowserMode);
  }

  private confirm = (message: string) => {
    return Electron.dialog.showMessageBoxSync({ message, buttons: ["Yes", "No"], defaultId: 0 }) === 0;
  }

  private onOpenWindow = (details: Electron.HandlerDetails) => {
    const action: "allow" | "deny" = !details.url.match(/^https?\/\//) || details.postBody ? "allow" : "deny";

    action === "deny" && Emit.share("browser:open", details.url);
    action === "allow" && Electron.app.once("browser-window-created", (_, browserWindow) => (
      browserWindow.webContents.on("did-navigate", () => {
        const url = browserWindow.webContents.getURL();

        if (url.match(/^https?:\/\//)) {
          Emit.share("browser:open", url);
          browserWindow.close();
        } else if (browserWindow.isVisible() === false) {
          browserWindow.show();
        }
      })
    ));

    return { action, overrideBrowserWindowOptions: { show: false } };
  }

  private onOpenUrl = (_: Electron.Event, url: string) => {
    Bootstrap.win?.focus();
    Emit.share("browser:open", url);
  }

  private onLogin = async (e: Electron.Event, _: Electron.LoginAuthenticationResponseDetails, __: Electron.AuthInfo, callback: Function) => {
    e.preventDefault();

    const user = await Emit.share("neovim:readline", "User");
    const password = await Emit.share("neovim:readline", "Password");

    user && callback(user, password);
  }

  private onCertError = async (e: Electron.Event, url: string, __: string, ___: Object, callback: Function) => {
    const { hostname } = new URL(url);

    if (this.ignoreCertErrorHost.indexOf(hostname) < 0) {
      lookup(hostname, 4, (e, address) => {
        if (e) return;
        if (
          ["0.0.0.0", "127.0.0.1"].indexOf(address) >= 0 ||
          this.confirm(`Certication Error on "${hostname}"\nContinue it?`)
        ) {
          this.ignoreCertErrorHost.push(hostname);
          this.webContents.loadURL(url);
        }
      });
    } else {
      e.preventDefault();
      callback(true);
    }
  }

  private onUnload = (e: Electron.Event) => {
    this.confirm("Leave this page?") && e.preventDefault();
  }

  private onContextMenu = (_: Electron.Event, params: Electron.ContextMenuParams) => {
    const contents = params.selectionText || params.srcURL;

    if (params.srcURL === this.webContents.getURL()) {
      this.webContents.downloadURL(contents);
    } else if (contents) {
      Emit.share("browser:open", contents);
    }
  }

  private onInput = (e: Electron.Event, input: Electron.Input) => {
    switch (input.key) {
      case "Escape":
        if (this.currentMode === "browser") {
          e.preventDefault();
          Emit.send("browser:action", this.webContents.id, "mode-command");
        }
        break;
    }
  }

  private onBrowserDevtool = () => {
    if (!this.devtoolWindow || this.devtoolWindow.isDestroyed()) {
      this.devtoolWindow = new Electron.BrowserWindow();
      this.devtoolWindow.setMenu(null);
      this.webContents.setDevToolsWebContents(this.devtoolWindow.webContents);
      this.webContents.openDevTools({ mode: "detach" });
    }
  }

  private onBrowserMode = (mode: string) => {
    this.currentMode = mode;
  }

  private onDestroy = () => {
    this.devtoolWindow?.destroy();
  }

  private onBrowserCapture = async (rect?: Electron.Rectangle) => {
    Electron.clipboard.writeImage(await this.webContents.capturePage(rect));
  }
}
