import type * as Electron from "electron";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { chromium, type BrowserContext, type ConnectOverCDPTransport, type Page } from "playwright-core";

import { acquireDebugger } from "main/browser/mcp/cdp";
import { Dialogs } from "main/browser/mcp/dialogs";
import { callFileTool, connectPlaywrightTools, isFileTool, videoDirectory, videoFiles } from "main/browser/mcp/playwright-tools";

interface Command {
  id: number;
  method: string;
  params?: object;
  sessionId?: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  attached: boolean;
}

interface Target {
  guest: Electron.WebContents;
  sessionId: string;
  targetInfo: TargetInfo;
  detach: () => void;
  page?: Page;
  dialogReady?: Promise<boolean>;
}

interface ChildSession {
  target: Target;
  id: string;
}

export class PlaywrightWorkspace {
  private readonly controller = new AbortController();
  private readonly targets = new Map<Electron.WebContents, Target>();
  private readonly sessions = new Map<string, Target>();
  private readonly detaching = new Set<Promise<unknown>>();
  private nextSession = 0;
  private readonly children = new Map<string, ChildSession>();
  private readonly context: Promise<BrowserContext>;
  private readonly transport: ConnectOverCDPTransport;
  private tools?: Promise<Client>;
  private recordingDirectory?: string;
  private active?: Target;

  constructor(private readonly available: (guest: Electron.WebContents) => boolean,
    private readonly open: (signal: AbortSignal) => Promise<Electron.WebContents>) {
    this.transport = {
      close: () => this.close(),
      send: message => {
        const { id, method, params, sessionId } = message as Command;
        void this.send(method, params, sessionId).then(
          result => this.forward({ id, sessionId, result }),
          error => this.forward({ id, sessionId, error: { code: -32000, message: String(error) } }),
        );
      },
    };
    this.context = chromium.connectOverCDP(this.transport, { noDefaults: true, timeout: 5000 }).then(browser => {
      const context = browser.contexts()[0];
      if (!context) throw new Error("Playwright did not create a browser context.");
      return context;
    });
  }

  get selected(): Electron.WebContents | undefined {
    return this.active?.guest;
  }

  get guests(): Electron.WebContents[] {
    return [...this.targets.keys()];
  }

  private forward(message: object): void {
    if (!this.controller.signal.aborted) this.transport.onmessage?.(message);
  }

  private async send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    const { signal } = this.controller;
    signal.throwIfAborted();
    if (sessionId) {
      const child = this.children.get(sessionId);
      const target = child?.target ?? this.sessions.get(sessionId);
      if (!target || !this.available(target.guest)) throw new Error("This tab is no longer shared in this workspace.");
      const result = await target.guest.debugger.sendCommand(method, params, child?.id);
      if (!child && method === "Page.bringToFront" && this.targets.has(target.guest)) this.active = target;
      return result;
    }
    switch (method) {
      case "Browser.getVersion":
        return { product: `Chrome/${process.versions.chrome}`, userAgent: `Chrome/${process.versions.chrome}` };
      case "Target.getTargetInfo": return {};
      case "Target.setAutoAttach": return {};
      case "Target.createTarget": {
        const guest = await this.open(signal);
        const target = await this.attach(guest);
        this.active = target;
        return { targetId: target.targetInfo.targetId };
      }
      default: throw new Error(`Unsupported browser-level command: ${method}`);
    }
  }

  async sync(guests: Electron.WebContents[]): Promise<void> {
    await this.context;
    for (const guest of this.targets.keys()) if (!this.available(guest)) this.remove(guest);
    await Promise.all(this.detaching);
    for (const guest of guests) if (this.available(guest)) await this.attach(guest);
  }

  private async attach(guest: Electron.WebContents): Promise<Target> {
    const existing = this.targets.get(guest);
    if (existing) return existing;

    const context = await this.context;
    this.controller.signal.throwIfAborted();
    if (!this.available(guest)) throw new Error("This tab is no longer shared in this workspace.");

    const { send, release } = acquireDebugger(guest);
    try {
      const { targetInfo } = await send("Target.getTargetInfo") as { targetInfo: TargetInfo };
      this.controller.signal.throwIfAborted();
      if (!this.available(guest)) throw new Error("This tab is no longer shared in this workspace.");
      const target: Target = {
        guest, sessionId: `envim-tab-${++this.nextSession}`, targetInfo: { ...targetInfo, type: "page", attached: true },
        detach: () => {
          guest.debugger.removeListener("message", onMessage);
          guest.debugger.removeListener("detach", onDetach);
          release();
        },
      };
      const onMessage = (_event: Electron.Event, method: string, params: unknown, child?: string) => {
        if (this.targets.get(guest) !== target || !this.available(guest)) return;
        this.onMessage(target, method, params, child);
      };
      const onDetach = () => this.remove(guest);
      guest.debugger.on("message", onMessage);
      guest.debugger.once("detach", onDetach);
      this.targets.set(guest, target);
      this.sessions.set(target.sessionId, target);
      this.active ??= target;
      const page = context.waitForEvent("page", { timeout: 5000 });
      this.forward({ method: "Target.attachedToTarget", params: {
        sessionId: target.sessionId, targetInfo: target.targetInfo, waitingForDebugger: false,
      } });
      target.page = await page;
      if (this.targets.get(guest) !== target || !this.available(guest)) throw new Error("This tab is no longer shared in this workspace.");
      return target;
    } catch (error) {
      this.remove(guest);
      release();
      throw error;
    }
  }

  private onMessage(target: Target, method: string, params: unknown, child?: string): void {
    if (!child && method === "Page.frameNavigated" && !(params as { frame: { parentId?: string } }).frame.parentId) {
    }
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      const event = params as { sessionId: string; targetInfo?: TargetInfo; waitingForDebugger?: boolean };
      const sessionId = `${target.sessionId}/${event.sessionId}`;
      if (method === "Target.attachedToTarget") {
        if (!["iframe", "worker"].includes(event.targetInfo?.type ?? "")) {
          if (event.waitingForDebugger) {
            void target.guest.debugger.sendCommand("Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
          }
          return;
        }
        this.children.set(sessionId, { target, id: event.sessionId });
      } else if (!this.children.delete(sessionId)) return;
      params = { ...event, sessionId };
    }
    if (method === "Page.javascriptDialogOpening") {
      if (!target.page || !this.tools || (params as { type?: string }).type !== "confirm" ||
          !Dialogs.willHoldConfirm(target.guest)) return;
      target.dialogReady = target.page.waitForEvent("dialog", { timeout: 1000 }).then(() => true, () => false);
    }
    if (method === "Page.javascriptDialogClosed") {
      if (!target.dialogReady) return;
      target.dialogReady = undefined;
      Dialogs.confirmClosed(target.guest);
    }
    const sessionId = child ? `${target.sessionId}/${child}` : target.sessionId;
    if (!child || this.children.has(sessionId)) this.forward({ method, params, sessionId });
  }

  remove(guest: Electron.WebContents): void {
    const target = this.targets.get(guest);
    if (!target) return;

    const index = this.guests.indexOf(guest);
    this.targets.delete(guest);
    this.sessions.delete(target.sessionId);
    if (target.page && !target.page.isClosed() && !this.controller.signal.aborted) {
      const closed = target.page.waitForEvent("close", { timeout: 5000 }).catch(() => {});
      this.detaching.add(closed);
      void closed.then(() => this.detaching.delete(closed));
    }
    if (this.active === target) this.active = [...this.targets.values()][Math.min(index, this.targets.size - 1)];
    for (const [sessionId, child] of this.children) if (child.target === target) this.children.delete(sessionId);
    this.forward({ method: "Target.detachedFromTarget", params: {
      sessionId: target.sessionId, targetId: target.targetInfo.targetId,
    } });
    target.detach();
  }

  async page(guest: Electron.WebContents): Promise<Page> {
    const target = this.targets.get(guest);
    if (!target?.page || !this.available(guest)) throw new Error("This tab is no longer shared in this workspace.");
    return target.page;
  }

  async answerDialog(guest: Electron.WebContents, accept: boolean): Promise<boolean> {
    const target = this.targets.get(guest);
    const ready = target?.dialogReady;
    if (!target || this.selected !== guest || !ready || !await ready || target.dialogReady !== ready) return false;
    const result = await this.callTool("browser_handle_dialog", { accept });
    return !result.isError || target.dialogReady !== ready;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const { signal } = this.controller;
    const context = await this.context;
    signal.throwIfAborted();
    const client = await (this.tools ??= connectPlaywrightTools(async () => context, signal).catch(error => {
      this.tools = undefined;
      throw error;
    }));
    if (isFileTool(name)) return callFileTool(client, name, args, signal);
    if (name === "browser_start_video") {
      if (this.recordingDirectory) throw new Error("Video recording has already been started.");
      const directory = await videoDirectory(client);
      try {
        const result = await client.callTool({ name, arguments: { ...args, filename: join(directory, "recording.webm") } }, { signal });
        if (!result.isError) {
          this.recordingDirectory = directory;
          return result;
        }
        await client.callTool({ name: "browser_stop_video", arguments: {} }, { signal });
        return result;
      } finally {
        if (this.recordingDirectory !== directory) await rm(directory, { recursive: true, force: true });
      }
    }
    return client.callTool({ name, arguments: args }, { signal });
  }

  async takeVideoFiles(): Promise<string[]> {
    const directory = this.recordingDirectory;
    this.recordingDirectory = undefined;
    return directory ? videoFiles(directory) : [];
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const guest of this.targets.keys()) this.remove(guest);
    void this.tools?.then(client => client.close()).catch(() => {});
    this.transport.onclose?.();
  }
}
