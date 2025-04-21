import React, { useEffect, useState, FormEvent, ChangeEvent } from "react";

import { ISetting } from "common/interface";

import { Emit } from "../utils/emit";
import { Setting } from "../utils/setting";

interface Props {
  width: number;
  height: number;
}

const flexDirection: "column" = "column";
const position: "absolute" = "absolute";
const styles = {
  scope: {
    padding: 8,
    display: "flex",
    alignItems: "center",
    overflow: "auto",
    flexDirection,
  },
  backdrop: {
    width: "100%",
    height: "100%",
    top: 0,
    left: 0,
    position,
    zIndex: -1,
  },
  logo: {
    fontSize: "2em",
    lineHeight: "1em",
    margin: "0 6px",
  },
  icon: {
    margin: "0 6px",
  },
  setting: {
    padding: "1rem",
    height: "100%",
    overflow: "auto",
  },
  button: {
    marginTop: "1em",
    padding: ".5em 1em",
    borderWidth: 1,
    borderRadius: ".2em",
  },
};

export function SettingComponent (props: Props) {
  const [state, setState] = useState<ISetting>({...Setting.get() });

  useEffect(() => {
    Emit.on("envim:setting", onSetting);
    Emit.send("envim:init");

    return () => {
      Emit.off("envim:setting", onSetting);
    }
  }, []);

  function onSetting (state: ISetting) {
    setState(() => state);
  }

  function onToggleType (e: ChangeEvent<HTMLInputElement>) {
    setState(state => {
      const type = e.target.value as ISetting["type"];
      const path = state.path;
      const { presets, searchengines, ...rest } = state.presets[`[${type}]:${path}`] || { type, path };

      return { ...state, ...rest };
    });
  }

  function onChangePath (e: ChangeEvent<HTMLInputElement>) {
    setState(state => {
      const path = e.target.value;
      const type = state.type;
      const { presets, searchengines, ...rest } = state.presets[`[${type}]:${path}`] || { type, path };

      return { ...state, ...rest };
    });
  }

  function onChangeFont (e: ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, font: { ...state.font, size: +e.target.value } }));
  }

  function onChangeLspace (e: ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, font: { ...state.font, lspace: +e.target.value } }));
  }

  function onChangeOpacity (e: ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, opacity: +e.target.value }));
  }

  function onToggleOption (e: ChangeEvent<HTMLInputElement>) {
    setState(({ options, ...state }) => {
      options[e.target.name] = e.target.checked;

      return { ...state, options };
    });
  }

  function onSelectBookmark(index: number) {
    setState(state => ({
      ...state,
      bookmarks: state.bookmarks.map((bookmark, i) => ({ ...bookmark, selected: i === index }))
    }));
  }

  function onSelectPreset(key: string) {
    setState(({ searchengines, presets, ...state }) => ({ ...state, ...presets[key], searchengines, presets }));
  }

  function onSubmit (e: FormEvent) {
    const { type, path, font, opacity, options, bookmarks, searchengines } = state;

    e.stopPropagation();
    e.preventDefault();

    Setting.type = type;
    Setting.path = path;
    Setting.font = { size: font.size, width: Math.floor(font.size * 0.6), height: font.size + font.lspace, lspace: font.lspace, scale: Math.ceil(window.devicePixelRatio) };
    Setting.opacity = opacity;
    Setting.options = options;
    Setting.bookmarks = bookmarks;
    Setting.searchengines = searchengines;

    Emit.send("envim:connect", type, path, bookmarks.find(({ selected }) => selected)?.path);
  }

  function getStyle() {
    return {
      opacity: (100 - state.opacity) / 100,
      ...styles.backdrop,
    };
  }

  function getExampleStyle() {
    return {
      padding: "4px 8px",
      fontSize: state.font.size,
      lineHeight: `${state.font.height}px`,
    };
  }

  return (
    <form className="color-inverse-fg" style={{ ...props, ...styles.scope }} onSubmit={onSubmit}>
      <div className="color-default" style={getStyle()}></div>
      <h1 className="bold">Welcome To Envim!</h1>
      <div>
        <i className="color-green-fg" style={styles.logo}></i>
        <i className="color-inverse-fg" style={styles.icon}>󰅖</i>
        <i className="color-lightblue-fg" style={styles.logo}></i>
      </div>

      <div style={styles.setting}>
        <h3 className="bold">Neovim path</h3>
        <div>
          <label><input type="radio" value="command" checked={state.type === "command"} onChange={onToggleType} />Command</label>
          <label><input type="radio" value="address" checked={state.type === "address"} onChange={onToggleType} />Server</label>
          <label><input type="radio" value="docker" checked={state.type === "docker"} onChange={onToggleType} />Docker</label>
          <label><input type="radio" value="ssh" checked={state.type === "ssh"} onChange={onToggleType} />SSH</label>
        </div>
        <label>Enter neovim path<input type="text" value={state.path} onChange={onChangePath} autoFocus /></label>
        <div className="color-gray divider" />

        <h3 className="bold">Appearance</h3>
        <div><label>Font Size ({state.font.size}px)<input type="range" min="5" max="20" value={state.font.size} onChange={onChangeFont} /></label></div>
        <div><label>Line Space ({state.font.lspace}px)<input type="range" min="0" max="10" value={state.font.lspace} onChange={onChangeLspace} /></label></div>
        <div style={getExampleStyle()}>Example Text</div>
        <div><label>Transparent ({state.opacity}%)<input type="range" min="0" max="50" value={state.opacity} onChange={onChangeOpacity} /></label></div>
        <div className="color-gray divider" />

        <h3 className="bold">Options</h3>
        { Object.keys(state.options).map((key, i) => (
          <label key={i}><input type="checkbox" name={key} checked={state.options[key]} onChange={onToggleOption} />{ key }</label>
        ))}
        <div className="color-gray divider" />

        <h3 className="bold">Bookmarks</h3>
        <div>
          <label><input type="radio" checked={!state.bookmarks.find(({ selected }) => selected)} onChange={() => onSelectBookmark(-1)} />Not select</label>
        </div>
        { state.bookmarks.map((bookmark, i) => (
          <div key={i}>
            <label><input type="radio" checked={bookmark.selected} onChange={() => onSelectBookmark(i)} />{ bookmark.name.replace(/\//g, "  ") }</label>
          </div>
        ))}

        <h3 className="bold">Presets</h3>
        { Object.keys(state.presets).map(key => (
          <div key={key}>
            <label><input type="radio" checked={`[${state.type}]:${state.path}` === key} onChange={() => onSelectPreset(key)} />{ key }</label>
          </div>
        ))}
      </div>

      <button className="color-blue clickable" style={styles.button}>Start</button>
    </form>
  );
}
