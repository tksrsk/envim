import * as Electron from "electron";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";

import { ISetting, settingSchema } from "common/setting";

export class Setting {
  private static item: ISetting;
  private static init: boolean = false;
  private static path: string = join(Electron.app.getPath("appData"), "envim.json");
  private static queue: Promise<void> = Promise.resolve();

  private static save() {
    const json = JSON.stringify(Setting.item);
    const tmp = `${Setting.path}.tmp`;

    const saving = Setting.queue
      .then(() => writeFile(tmp, json, { encoding: "utf8" }))
      .then(() => rename(tmp, Setting.path));

    Setting.queue = saving.catch(error => console.error("Could not save settings", error));
    return saving;
  }

  static set(item: ISetting) {
    const { presets } = Setting.item || { presets: {} };

    Setting.init = true;
    Setting.item = {
      ...item,
      presets: { ...presets, [`[${item.type}]:${item.path}`]: { ...item, presets: {} } },
    };

    return Setting.save();
  }

  static remove(type: string, path: string) {
    delete(Setting.item.presets[`[${type}]:${path}`]);

    Setting.save();
  }

  static get() {
    if (!Setting.init) {
      Setting.init = true;
      if (existsSync(Setting.path)) {
        try {
          const item: unknown = JSON.parse(readFileSync(Setting.path, "utf8"));
          Setting.item = settingSchema.parse(item);
        } catch (error) {
          console.error("Could not load settings", error);
        }
      }
    }

    return Setting.item;
  }
}
