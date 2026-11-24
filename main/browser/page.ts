import * as Electron from "electron";
import { lookup } from "dns";

import { Bootstrap } from "main/bootstrap";
import { Emit } from "main/emit";
import { Dialogs } from "main/browser/mcp/dialogs";

export class BrowserPage {
  private ignoreCertErrorHost: string[] = [];
  private devtoolWindow?: Electron.BrowserWindow;
  private focused = false;

  constructor(private webContents: Electron.WebContents, private readonly openTab: (url: string) => void,
    openPopup: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse, private readonly onCommandMode: () => void) {
    Dialogs.track(webContents);
    webContents.setWindowOpenHandler(openPopup);
    webContents.on("devtools-open-url", this.onOpenUrl);
    webContents.on("login", this.onLogin);
    webContents.on("certificate-error", this.onCertError);
    webContents.on("will-prevent-unload", this.onUnload);
    webContents.on("context-menu", this.onContextMenu);
    webContents.on("before-input-event", this.onInput);
    webContents.on("focus", () => { this.focused = true; });
    webContents.on("blur", () => { this.focused = false; });
    webContents.once("destroyed", () => this.devtoolWindow?.destroy());
  }

  openDevtools() {
    if (!this.devtoolWindow || this.devtoolWindow.isDestroyed()) {
      this.devtoolWindow = new Electron.BrowserWindow();
      this.devtoolWindow.setMenu(null);
      this.webContents.setDevToolsWebContents(this.devtoolWindow.webContents);
      this.webContents.openDevTools({ mode: "detach" });
    }
  }

  private confirm = (message: string) => {
    return Electron.dialog.showMessageBoxSync({ message, buttons: ["Yes", "No"], defaultId: 0 }) === 0;
  }

  private onOpenUrl = (_: Electron.Event, url: string) => {
    Bootstrap.win?.focus();
    this.openTab(url);
  }

  private onLogin = async (e: Electron.Event, _: Electron.AuthenticationResponseDetails, __: Electron.AuthInfo, callback: Function) => {
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
      setImmediate(() => callback(true));
    }
  }

  private onUnload = (e: Electron.Event) => {
    if (Dialogs.leaveForAgent(this.webContents) || this.confirm("Leave this page?")) e.preventDefault();
  }

  private onContextMenu = (_: Electron.Event, params: Electron.ContextMenuParams) => {
    const contents = params.selectionText || params.srcURL;

    if (params.srcURL === this.webContents.getURL()) {
      this.webContents.downloadURL(contents);
    } else if (contents) {
      this.openTab(contents);
    }
  }

  private onInput = (e: Electron.Event, input: Electron.Input) => {
    switch (input.key) {
      case "Escape":
        if (this.focused) {
          e.preventDefault();
          Bootstrap.win?.webContents.focus();
          this.onCommandMode();
        }
        break;
    }
  }
}
