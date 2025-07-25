import { app } from "electron";
import { join } from "path";
import { existsSync, readFileSync, writeFile } from "fs";

import { ISetting } from "common/interface";

export class Setting {
  private static item: ISetting
  private static init: boolean = false;
  private static path: string = join(app.getPath("appData"), "envim.json");

  static set(item: ISetting) {
    const { presets } = Setting.item || { presets: {} };

    Setting.init = true;
    Setting.item = { ...item, presets };
    Setting.item.presets[`[${item.type}]:${item.path}`] = JSON.parse(JSON.stringify(item));
    Setting.item.presets[`[${item.type}]:${item.path}`].presets = {};

    writeFile(Setting.path, JSON.stringify(Setting.item), { encoding: "utf8" }, () => {});
  }

  static remove(type: string, path: string) {
    delete(Setting.item.presets[`[${type}]:${path}`])

    writeFile(Setting.path, JSON.stringify(Setting.item), { encoding: "utf8" }, () => {});
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
