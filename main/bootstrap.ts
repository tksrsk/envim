import * as Electron from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { lookup } from "mime-types";

import { Emit } from "main/emit";
import { Browser } from "main/browser";

export class Bootstrap {
  static win?: Electron.BrowserWindow;

  constructor() {
    Electron.Menu.setApplicationMenu(
      Electron.Menu.buildFromTemplate([
        { role: "editMenu", visible: true }
      ])
    );
    Electron.app.commandLine.appendSwitch("remote-debugging-port", "8315");
    Electron.app.on("ready", this.onReady);
    Electron.app.on("activate", this.onActivate);
    Electron.app.on("window-all-closed", this.onQuit);
  }

  private onReady = () => {
    this.create();
  }

  private onActivate = () => {
    this.create();
  }

  private onQuit = () => {
    delete(Bootstrap.win);
    Electron.app.quit();
  }

  private create() {
    if (Bootstrap.win) return;

    Bootstrap.win = new Electron.BrowserWindow({
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
    Bootstrap.win.loadFile(join(__dirname, "../renderer/index.html"));
    Bootstrap.win.on("closed", this.onQuit);
    Bootstrap.win.on("resize", () => Bootstrap.win && Emit.update("app:resize", true, ...Bootstrap.win.getSize()));
    Bootstrap.win.on("leave-full-screen", () => Bootstrap.win && Emit.send("app:resize", ...Bootstrap.win.getSize()));
    Bootstrap.win.once("ready-to-show", () => Emit.share("envim:theme"));
    Bootstrap.win.webContents.on("did-attach-webview", (_, webContents) => new Browser(webContents));
    Bootstrap.win.webContents.on("will-navigate", (e, url) => {
      const { protocol, pathname } = new URL(url);

      e.preventDefault();

      if (["file:"].includes(protocol)) Emit.share("envim:command", `edit ${pathname}`);
      if (["http:", "https:"].includes(protocol)) Emit.share("envim:browser", url);
    });
    Bootstrap.win.webContents.on("will-attach-webview", (_, webPreferences) => {
      delete(webPreferences.preload);
      webPreferences.nodeIntegration = false;
      webPreferences.transparent = false;
    });
    Electron.session.defaultSession.protocol.handle("file", async (request) => {
      const filePath = decodeURIComponent(new URL(request.url).pathname);
      const path = process.platform === "win32" ? filePath.replace(/^\//, "") : filePath;

      if (existsSync(path)) {
        return Electron.net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      }

      try {
        const list = await Emit.share("envim:api", "nvim_call_function", ["EnvimReadBlob", [filePath]]) as number[] | null;
        if (list) {
          return new Response(new Uint8Array(Buffer.from(list)), { headers: { "Content-Type": lookup(filePath) || "application/octet-stream" } });
        }
      } catch {}

      return new Response(null, { status: 404 });
    });
  }
}
