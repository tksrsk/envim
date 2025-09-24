import { app, session, BrowserWindow, Menu } from "electron";
import { join } from "path";
import { readdir } from "fs";

import { Emit } from "./emit";
import { Browser } from "./browser";

export class Bootstrap {
  static win?: BrowserWindow;

  constructor() {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "editMenu", visible: true }
      ])
    );
    app.commandLine.appendSwitch("remote-debugging-port", "8315");
    app.on("ready", this.onReady);
    app.on("activate", this.onActivate);
    app.on("window-all-closed", this.onQuit);
  }

  private onReady = () => {
    this.create();
  }

  private onActivate = () => {
    this.create();
  }

  private onQuit = () => {
    delete(Bootstrap.win);
    app.quit();
  }

  private create() {
    if (Bootstrap.win) return;

    Bootstrap.win = new BrowserWindow({
      transparent: true,
      resizable: true,
      hasShadow: false,
      titleBarStyle: "hidden",
      titleBarOverlay: true,
      webPreferences: {
        webviewTag: true,
        spellcheck: false,
        preload: join(__dirname, "../preload/index.js"),
      },
    });

    Bootstrap.win.maximize();
    Bootstrap.win.loadFile(join(__dirname, "../../dist/index.html"));
    Bootstrap.win.on("closed", this.onQuit);
    Bootstrap.win.on("resize", () => Bootstrap.win && Emit.update("app:resize", true, ...Bootstrap.win.getSize()));
    Bootstrap.win.on("leave-full-screen", () => Bootstrap.win && Emit.send("app:resize", ...Bootstrap.win.getSize()));
    Bootstrap.win.once("ready-to-show", () => Emit.share("envim:theme"));
    Bootstrap.win.webContents.on("did-attach-webview", (_, webContents) => new Browser(webContents));
    Bootstrap.win.webContents.on("will-navigate", e => e.preventDefault());
    Bootstrap.win.webContents.on("will-attach-webview", (_, webPreferences) => {
      delete(webPreferences.preload);
      webPreferences.nodeIntegration = false;
      webPreferences.transparent = false;
    });

    readdir(join(__dirname, "../../../extensions"), (e, paths) => {
      e || paths.forEach(async path => {
        const extention = join(__dirname, "../../../extensions", path);
        path.startsWith(".") || session.defaultSession.extensions.loadExtension(extention, { allowFileAccess: true });
      });
    });
  }
}
