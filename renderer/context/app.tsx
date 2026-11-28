import React from "react";

import { ISetting, settingSchema } from "common/setting";
import { Emit } from "renderer/utils/emit";

type UpdateSetting = (update: (current: ISetting) => ISetting) => boolean;

interface AppContextType {
  setting: ISetting;
  grid: ReturnType<typeof gridSize>;
  updateSetting: UpdateSetting;
  connect: (setting: ISetting, bookmark?: string) => void;
}

function gridSize({ width, height }: Pick<ISetting["font"], "width" | "height">) {
  return {
    y2Row: (y: number) => Math.trunc(y / height),
    x2Col: (x: number) => Math.trunc(x / width),
    row2Y: (row: number) => row * height,
    col2X: (col: number) => col * width,
  };
}

const AppContext = React.createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [setting, setSetting] = React.useState(() => settingSchema.parse({ font: { scale: window.devicePixelRatio } }));
  const current = React.useRef(setting);

  const receive = React.useCallback((next: ISetting) => {
    current.current = next;
    setSetting(next);
  }, []);

  React.useEffect(() => {
    Emit.on("app:setting", receive);
    Emit.send("app:init");
    return () => Emit.off("app:setting", receive);
  }, [receive]);

  const updateSetting = React.useCallback<UpdateSetting>(update => {
    const previous = current.current;
    const next = update(previous);
    if (next === previous) return false;

    const parsed = settingSchema.safeParse(next);
    if (!parsed.success) {
      return false;
    }

    receive(parsed.data);
    Emit.send("app:setting", parsed.data);
    return true;
  }, [receive]);

  const connect = React.useCallback((setting: ISetting, bookmark?: string) => {
    Emit.send("neovim:connect", setting, bookmark);
  }, []);

  const { width, height } = setting.font;
  const grid = React.useMemo(() => gridSize({ width, height }), [width, height]);
  const value = React.useMemo(() => ({ setting, grid, updateSetting, connect }), [setting, grid, updateSetting, connect]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = React.useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
