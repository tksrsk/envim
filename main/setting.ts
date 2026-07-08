import * as Electron from "electron";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";

import { ISetting } from "common/interface";

export class Setting {
  private static item: ISetting;
  private static init: boolean = false;
  private static path: string = join(Electron.app.getPath("appData"), "envim.json");
  private static queue: Promise<void> = Promise.resolve();

  private static save() {
    const json = JSON.stringify(Setting.item);
    const tmp = `${Setting.path}.tmp`;

    Setting.queue = Setting.queue
      .then(() => writeFile(tmp, json, { encoding: "utf8" }))
      .then(() => rename(tmp, Setting.path))
      .catch(() => {});
  }

  static set(item: ISetting) {
    const { presets } = Setting.item || { presets: {} };

    Setting.init = true;
    Setting.item = { ...item, presets };
    Setting.item.presets[`[${item.type}]:${item.path}`] = JSON.parse(JSON.stringify(item));
    Setting.item.presets[`[${item.type}]:${item.path}`].presets = {};

    Setting.save();
  }

  static remove(type: string, path: string) {
    delete(Setting.item.presets[`[${type}]:${path}`]);

    Setting.save();
  }

  static get() {
    if (Setting.init === false && existsSync(Setting.path)) {
      const item = readFileSync(Setting.path, { encoding: "utf8" });

      Setting.item = JSON.parse(item);
      Setting.init = true;
    }

    return Setting.item;
  }
}
