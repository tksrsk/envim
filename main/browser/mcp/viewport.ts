import type * as Electron from "electron";
import { devices, type BrowserContextOptions } from "playwright-core";

import type { IBrowserViewport } from "common/interface";

import { acquireDebugger } from "main/browser/mcp/cdp";
import { runInPage } from "main/browser/mcp/inject";
import type { WorkspaceEmit } from "main/emit";

const MAX_VIEWPORT_SIZE = 4096;

export const browserViewportTool = {
  name: "browser_viewport",
  description: "Measure a shared tab's viewport in CSS pixels, set a size or Playwright device preset, or reset to the default.",
  inputSchema: {
    type: "object" as const,
    properties: {
      tab: { type: "integer", description: "Shared tab ID. Defaults to the selected tab." },
      width: { type: "integer", minimum: 1, maximum: MAX_VIEWPORT_SIZE, description: "Emulated width in CSS pixels. Requires height." },
      height: { type: "integer", minimum: 1, maximum: MAX_VIEWPORT_SIZE, description: "Emulated height in CSS pixels. Requires width." },
      device: { type: "string", enum: Object.keys(devices), description: "Device preset. Omit width and height to use the preset dimensions." },
      reset: { type: "boolean", description: "Restore the default viewport. Omit width, height and device when true." },
    },
  },
};

export class BrowserViewports {
  private readonly emulatedViewports = new WeakMap<Electron.WebContents, IBrowserViewport>();
  private readonly configuringDevices = new WeakSet<Electron.WebContents>();
  private readonly deviceCleanup = new WeakMap<Electron.WebContents, () => Promise<void>>();

  constructor(private readonly emit: WorkspaceEmit, private readonly isShared: (id: number) => boolean) {}

  get(guest: Electron.WebContents): IBrowserViewport | null {
    return this.emulatedViewports.get(guest) ?? null;
  }

  async reset(guest: Electron.WebContents): Promise<void> {
    const cleanup = this.deviceCleanup.get(guest)?.();
    const viewport = this.emulatedViewports.get(guest);
    this.emulatedViewports.delete(guest);
    if (viewport && !guest.isDestroyed()) {
      if (!viewport.device) guest.disableDeviceEmulation();
      this.emit.send("browser:viewport:changed", guest.id, null);
    }
    await cleanup;
  }

  private async enableDevice(guest: Electron.WebContents, device: string, width: number, height: number): Promise<void> {
    const preset: typeof devices[string] & Pick<BrowserContextOptions, "screen"> = devices[device];
    const { screen, deviceScaleFactor, isMobile, hasTouch, userAgent } = preset;
    const debuggerClient = guest.debugger;

    const { send, release } = acquireDebugger(guest);
    const onDetach = () => void this.reset(guest);
    const cleanup = async () => {
      this.deviceCleanup.delete(guest);
      debuggerClient.removeListener("detach", onDetach);
      try {
        if (!guest.isDestroyed() && debuggerClient.isAttached()) {
          await Promise.allSettled([
            send("Emulation.clearDeviceMetricsOverride"),
            send("Emulation.setTouchEmulationEnabled", { enabled: false }),
            send("Emulation.setUserAgentOverride", { userAgent: "" }),
          ]);
        }
      } finally {
        release();
      }
    };
    this.deviceCleanup.set(guest, cleanup);
    debuggerClient.once("detach", onDetach);

    try {
      const results = await Promise.allSettled([
        send("Emulation.setDeviceMetricsOverride", {
          width, height, screenWidth: screen?.width ?? width, screenHeight: screen?.height ?? height,
          deviceScaleFactor, mobile: isMobile,
        }),
        send("Emulation.setTouchEmulationEnabled", { enabled: hasTouch, maxTouchPoints: hasTouch ? 5 : 1 }),
        send("Emulation.setUserAgentOverride", { userAgent }),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      if (this.deviceCleanup.get(guest) !== cleanup) throw new Error("Device emulation was interrupted.");
    } catch (error) {
      if (this.deviceCleanup.get(guest) === cleanup) await cleanup();
      throw error;
    }
  }

  async apply(guest: Electron.WebContents, params: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.isShared(guest.id)) throw new Error(`Tab ${guest.id} is no longer available to this session.`);

    const { device, reset = false } = params;
    if (typeof reset !== "boolean") throw new Error("Reset must be a boolean.");
    if (device !== undefined && (typeof device !== "string" || !Object.hasOwn(devices, device))) {
      throw new Error("Choose a device name from the viewport tool schema.");
    }
    if (this.configuringDevices.has(guest)) throw new Error("A viewport change is in progress. Try again.");
    if (reset) {
      if (params.width !== undefined || params.height !== undefined || device !== undefined) {
        throw new Error("Omit width, height and device when resetting the viewport.");
      }
      await this.reset(guest);
    } else if (device || params.width !== undefined || params.height !== undefined) {
      const preset = device && params.width === undefined && params.height === undefined ? devices[device].viewport : undefined;
      const width = preset?.width ?? params.width;
      const height = preset?.height ?? params.height;
      if (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > MAX_VIEWPORT_SIZE ||
          typeof height !== "number" || !Number.isInteger(height) || height < 1 || height > MAX_VIEWPORT_SIZE) {
        throw new Error(`Width and height must both be integers between 1 and ${MAX_VIEWPORT_SIZE}.`);
      }

      this.configuringDevices.add(guest);
      try {
        if (device || this.deviceCleanup.has(guest)) await this.reset(guest);
        signal.throwIfAborted();
        if (!this.isShared(guest.id)) throw new Error(`The viewport change on tab ${guest.id} was interrupted.`);
        if (device) {
          await this.enableDevice(guest, device, width, height);
          signal.throwIfAborted();
          if (!this.isShared(guest.id) || !this.deviceCleanup.has(guest)) {
            throw new Error(`The viewport change on tab ${guest.id} was interrupted.`);
          }
        } else {
          guest.enableDeviceEmulation({
            screenPosition: "desktop",
            screenSize: { width: 0, height: 0 },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 0,
            viewSize: { width, height },
            scale: 1,
          });
        }
        const viewport: IBrowserViewport = { device, style: { width, height } };
        this.emulatedViewports.set(guest, viewport);
        this.emit.send("browser:viewport:changed", guest.id, viewport);
      } catch (error) {
        if (device) await this.reset(guest);
        throw error;
      } finally {
        this.configuringDevices.delete(guest);
      }
    }

    const url = guest.getURL();
    const size = await runInPage<{ width: number; height: number; devicePixelRatio: number; maxTouchPoints: number }>(guest,
      "({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints })");
    signal.throwIfAborted();
    if (!this.isShared(guest.id) || guest.getURL() !== url) {
      throw new Error(`Tab ${guest.id} changed while its viewport was measured. Try again.`);
    }
    const viewport = this.emulatedViewports.get(guest);
    const emulation = viewport ? { ...viewport.style, device: viewport.device } : null;
    return { tab: guest.id, url, title: guest.getTitle(), ...size, emulation };
  }
}
