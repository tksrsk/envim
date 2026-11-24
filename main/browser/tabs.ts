import * as Electron from "electron";

import type { BrowserTabCommand, IWorkspaceBrowserTab, IWorkspaceBrowserState } from "common/interface";
import { Bootstrap } from "main/bootstrap";
import { BrowserPage } from "main/browser/page";
import type { WorkspaceEmit } from "main/emit";
import { registerBrowserOwner } from "main/browser/mcp/sharedbrowser";

interface Tab {
  view: Electron.WebContentsView;
  page: BrowserPage;
  favicon?: string;
  shared?: boolean;
  selecting?: string;
  selection?: Electron.Rectangle;
  selectionQueue?: Promise<void>;
  selectionPaintPending?: boolean;
}

export class BrowserTabs {
  private readonly tabs = new Map<number, Tab>();
  private selected?: number;
  private visible?: Tab;
  private bounds?: Electron.Rectangle;
  private active = false;

  constructor(private readonly workspace: string, private readonly emit: WorkspaceEmit) {
    emit.on("browser:tabs:get", this.onBrowserTabsGet);
    emit.on("browser:tabs:select", this.onBrowserTabsSelect);
    emit.on("browser:tabs:close", this.onBrowserTabsClose);
    emit.on("browser:bounds:update", this.onBrowserBoundsUpdate);
    emit.on("browser:tab:command", this.onBrowserTabCommand);
  }

  activate(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.bounds = undefined;
    this.updateVisibility();
  }

  private onBrowserTabsGet = (): IWorkspaceBrowserState => {
    return {
      selected: this.selected,
      tabs: [...this.tabs].map(([id, tab]): IWorkspaceBrowserTab => {
        const page = tab.view.webContents;
        return {
          id, url: page.getURL(), title: page.getTitle(), favicon: tab.favicon, shared: tab.shared ?? false,
          focused: page.isFocused(), loading: page.isLoadingMainFrame(), zoom: page.getZoomLevel(),
        };
      }),
    };
  };

  setShared(id: number, shared: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.shared === shared) return;

    tab.shared = shared;
    this.publish();
  }

  private publish(): void {
    this.emit.send("browser:tabs:changed", this.onBrowserTabsGet());
  }

  private select(id: number, reveal = false): void {
    if (!this.tabs.has(id)) return;
    this.selected = id;
    this.updateVisibility();
    this.publish();
    if (reveal) this.emit.send("browser:surface:show");
  }

  private onBrowserTabsSelect = (id: number) => {
    this.select(id);
  };

  private onBrowserTabsClose = (id: number) => {
    this.tabs.get(id)?.view.webContents.close();
  };

  private onBrowserBoundsUpdate = (bounds: Electron.Rectangle | null) => {
    this.bounds = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
      bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
    this.updateVisibility();
  };

  private updateVisibility(): void {
    const window = Bootstrap.win;
    const tab = this.active && this.bounds && this.selected !== undefined ? this.tabs.get(this.selected) : undefined;
    if (this.visible && this.visible !== tab) {
      if (this.visible.selection) void this.showSelection(this.visible, null).catch(() => {});
      this.visible.view.setVisible(false);
    }
    this.visible = tab;
    if (!tab || !window || !this.bounds) return;

    const { x, y, width, height } = this.bounds;
    const zoom = window.webContents.getZoomFactor();
    tab.view.setBounds({
      x: Math.round(x * zoom), y: Math.round(y * zoom),
      width: Math.max(1, Math.round(width * zoom)), height: Math.max(1, Math.round(height * zoom)),
    });
    tab.view.setVisible(true);
  }

  private create(options?: Electron.BrowserWindowConstructorOptions): Tab {
    const window = Bootstrap.win;
    if (!window || window.isDestroyed()) throw new Error("The browser window is unavailable.");
    const view = new Electron.WebContentsView({ ...options, webPreferences: {
      ...options?.webPreferences, preload: undefined, webviewTag: false, nodeIntegration: false, contextIsolation: true, sandbox: true,
    } });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    view.setVisible(false);
    const attach = () => {
      if (!window.isDestroyed() && !view.webContents.isDestroyed()) window.contentView.addChildView(view);
    };
    if (options) setImmediate(attach);
    else attach();
    const page = view.webContents;
    const { id } = page;
    const tab = { view } as Tab;
    this.tabs.set(id, tab);
    registerBrowserOwner(page, this.workspace);
    tab.page = new BrowserPage(page, url => void this.open(url).catch(() => {}), details => {
      if (!/^(https?:\/\/|about:blank$)/i.test(details.url)) return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: options => {
          const child = this.create(options).view.webContents;
          setImmediate(() => {
            if (child.isDestroyed()) return;
            if (details.disposition !== "background-tab" && this.visible === tab) this.select(child.id, true);
            else this.publish();
          });
          return child;
        },
      };
    }, () => this.emit.send("browser:mode:command", id));
    const publish = () => this.publish();
    page.on("did-start-loading", publish);
    page.on("did-stop-loading", publish);
    page.on("did-navigate-in-page", publish);
    page.on("page-title-updated", publish);
    page.on("focus", publish);
    page.on("blur", publish);
    page.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
      if (!isMainFrame || isSameDocument || !tab.favicon) return;
      tab.favicon = undefined;
      publish();
    });
    page.on("page-favicon-updated", (_event, urls) => {
      const favicon = urls.find(url => /^(https?:\/\/|data:image\/)/i.test(url));
      if (tab.favicon === favicon) return;
      tab.favicon = favicon;
      publish();
    });
    page.on("console-message", event => {
      if (!tab.selecting || event.message !== `envim-picked:${tab.selecting}`) return;
      this.emit.send("browser:element-picked", id, tab.selecting);
      tab.selecting = undefined;
    });
    page.on("did-navigate", () => { tab.selecting = undefined; publish(); });
    page.once("destroyed", () => {
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
      }
      const index = [...this.tabs.keys()].indexOf(id);
      this.tabs.delete(id);
      if (this.selected === id) {
        this.selected = [...this.tabs.keys()][Math.min(index, this.tabs.size - 1)];
        if (this.visible === tab) this.visible = undefined;
        this.updateVisibility();
      }
      this.publish();
    });
    return tab;
  }

  async open(url = "", reveal = true): Promise<Electron.WebContents> {
    const page = this.create().view.webContents;
    if (reveal || this.selected === undefined) this.select(page.id, reveal);
    else this.publish();
    try {
      await page.loadURL(this.destination(url));
      this.publish();
      return page;
    } catch (error) {
      if (!page.isDestroyed()) page.close();
      throw error;
    }
  }

  private destination(url: string): string {
    if (!url) return "about:blank";
    if (["http:", "https:", "file:", "data:", "about:"].includes(new URL(url).protocol)) return url;
    throw new Error("This address cannot be opened in the browser.");
  }

  private pageRect(tab: Tab, rect: unknown): Electron.Rectangle | undefined {
    if (!rect || typeof rect !== "object" || !Bootstrap.win) return;
    const { x, y, width, height } = rect as Electron.Rectangle;
    if (![x, y, width, height].every(Number.isFinite)) return;
    const zoom = Bootstrap.win.webContents.getZoomFactor();
    const bounds = tab.view.getBounds();
    const left = Math.max(0, Math.round(x * zoom));
    const top = Math.max(0, Math.round(y * zoom));
    const right = Math.min(bounds.width, Math.round((x + width) * zoom));
    const bottom = Math.min(bounds.height, Math.round((y + height) * zoom));
    if (left < right && top < bottom) return { x: left, y: top, width: right - left, height: bottom - top };
    return undefined;
  }

  private queueSelection(tab: Tab, action: () => Promise<void>): Promise<void> {
    const operation = (tab.selectionQueue ?? Promise.resolve()).catch(() => {}).then(action);
    tab.selectionQueue = operation;
    return operation;
  }

  private async paintSelection(tab: Tab, bounds?: Electron.Rectangle, waitForPaint = false): Promise<void> {
    const page = tab.view.webContents;
    if (page.isDestroyed()) return;
    const zoom = page.getZoomFactor();
    await page.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
      const bounds = ${JSON.stringify(bounds ?? null)};
      let marker = globalThis.envimCaptureMarker;
      if (!bounds) {
        marker?.remove();
      } else {
        marker ??= document.createElement("div");
        globalThis.envimCaptureMarker = marker;
        const scale = ${zoom} * (window.visualViewport?.scale || 1);
        Object.assign(marker.style, {
          position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none",
          transition: "transform 100ms linear, width 100ms linear, height 100ms linear",
          backdropFilter: "invert(1)", boxShadow: "0 0 2px 2px rgba(0, 0, 0, 0.2)",
          transform: "translate(" + bounds.x / scale + "px, " + bounds.y / scale + "px)",
          width: bounds.width / scale + "px", height: bounds.height / scale + "px",
        });
        if (!marker.isConnected) document.documentElement.append(marker);
      }
      if (${waitForPaint} && !document.hidden) {
        return new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
          setTimeout(resolve, 150);
        });
      }
    })()` }]);
  }

  private showSelection(tab: Tab, rect: unknown): Promise<void> {
    tab.selection = this.visible === tab ? this.pageRect(tab, rect) : undefined;
    if (tab.selectionPaintPending) return tab.selectionQueue!;
    tab.selectionPaintPending = true;
    return this.queueSelection(tab, () => {
      tab.selectionPaintPending = false;
      return this.paintSelection(tab, tab.selection);
    });
  }

  private capture(tab: Tab, rect: unknown): Promise<void> {
    return this.queueSelection(tab, async () => {
      if (this.visible !== tab) return;
      const bounds = this.pageRect(tab, rect);
      if (rect != null && !bounds) return;
      await this.paintSelection(tab, undefined, true);
      try {
        if (this.visible !== tab || tab.view.webContents.isDestroyed()) return;
        const image = await tab.view.webContents.capturePage(bounds);
        if (image.isEmpty()) return;
        const png = new Blob([new Uint8Array(image.toPNG())], { type: "image/png" });
        await Electron.clipboard.write([new Electron.ClipboardItem({ "image/png": png })]);
      } finally {
        if (this.visible === tab && tab.selection) await this.paintSelection(tab, tab.selection);
      }
    });
  }

  private onBrowserTabCommand = (id: number, ...[action, arg, forward = true]: BrowserTabCommand) => {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const page = tab.view.webContents;
    switch (action) {
      case "navigate": if (typeof arg === "string") { void page.loadURL(this.destination(arg)).catch(() => {}); } break;
      case "back": if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack(); break;
      case "forward": if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward(); break;
      case "reload": page.reloadIgnoringCache(); break;
      case "stop": page.stop(); break;
      case "find": if (typeof arg === "string" && arg) page.findInPage(arg, { forward }); break;
      case "stop-find": page.stopFindInPage("clearSelection"); break;
      case "send-escape":
        if (this.visible === tab) page.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        break;
      case "zoom": if (typeof arg === "number" && Number.isFinite(arg)) { page.setZoomLevel(arg); this.publish(); } break;
      case "selection": return this.showSelection(tab, arg);
      case "capture": return this.capture(tab, arg);
      case "cursor": {
        if (this.visible !== tab || !arg || typeof arg !== "object") break;
        const { point, selection } = arg as { point?: unknown; selection?: unknown };
        const bounds = this.pageRect(tab, point);
        if (bounds) page.sendInputEvent({ type: "mouseMove", x: bounds.x, y: bounds.y });
        return this.showSelection(tab, selection);
      }
      case "cursor-click": {
        if (this.visible !== tab) break;
        const point = this.pageRect(tab, arg);
        if (!point) break;
        const { x, y } = point;
        page.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        page.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        break;
      }
      case "scroll": {
        const distance = new Map([
          ["h", "-100, 0"], ["j", "0, 100"], ["k", "0, -100"], ["l", "100, 0"],
          ["u", "0, -innerHeight"], ["d", "0, innerHeight"],
        ]);
        const offset = typeof arg === "string" ? distance.get(arg) : undefined;
        if (this.visible === tab && offset) void page.executeJavaScript(`window.scrollBy(${offset})`).catch(() => {});
        break;
      }
      case "scroll-edge":
        if (this.visible === tab) {
          void page.executeJavaScript(arg === "top" ? "window.scrollTo(0, 0)" : "window.scrollTo(0, document.documentElement.scrollHeight)").catch(() => {});
        }
        break;
      case "focus": if (this.visible === tab) page.focus(); break;
      case "devtools": tab.page.openDevtools(); break;
      case "pick":
        if (arg === null || (typeof arg === "string" && /^[0-9a-f-]{36}$/.test(arg))) {
          tab.selecting = arg ?? undefined;
          void page.executeJavaScript(pickScript(arg)).catch(() => { tab.selecting = undefined; });
        }
        break;
    }
    return undefined;
  };

  dispose(): void {
    this.activate(false);
    for (const { view } of this.tabs.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.tabs.clear();
  }
}

function pickScript(token: string | null): string {
  return `(() => {
    window.__envimPicker?.abort();
    document.querySelectorAll('[data-envim-picking]').forEach(node => node.removeAttribute('data-envim-picking'));
    const token = ${JSON.stringify(token)};
    if (!token) return;
    const controller = new AbortController();
    window.__envimPicker = controller;
    const style = document.createElement('style');
    style.textContent = '[data-envim-picking]{outline:2px dotted #9968cc!important;cursor:crosshair!important}';
    document.documentElement.append(style);
    let target;
    const options = { capture:true, signal:controller.signal };
    controller.signal.addEventListener('abort', () => { target?.removeAttribute('data-envim-picking'); style.remove(); }, {once:true});
    const targetFrom = event => {
      const hit = event.composedPath()[0];
      const roots = [document.body, document.documentElement];
      if (!(hit instanceof Element) || roots.includes(hit)) return;
      let element = hit;
      while (element.parentElement && !(element instanceof HTMLElement)) element = element.parentElement;
      return roots.includes(element) ? hit : element;
    };
    addEventListener('pointermove', event => {
      target?.removeAttribute('data-envim-picking');
      target = targetFrom(event);
      if (target) target.setAttribute('data-envim-picking',token);
    }, options);
    addEventListener('pointerdown', event => { event.preventDefault(); event.stopImmediatePropagation(); }, options);
    addEventListener('click', event => {
      event.preventDefault();event.stopImmediatePropagation();
      const element = targetFrom(event);
      if (!element) return;
      element.setAttribute('data-envim-picked',[element.getAttribute('data-envim-picked'),token].filter(Boolean).join(' '));
      console.info('envim-picked:'+token);
      controller.abort();
    }, options);
  })()`;
}
