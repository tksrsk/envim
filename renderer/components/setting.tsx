import React from "react";

import { ISetting } from "common/interface";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";

import { FlexComponent } from "renderer/components/flex";

const envimIconUrl = new URL("../../assets/envim-icon.png", import.meta.url).href;

interface Props {
  width: number;
  height: number;
}

const styles: { [key: string]: React.CSSProperties } = {
  scope: {
    isolation: "isolate",
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: "normal"
  },
  title: {
    margin: "2px 0 5px",
    fontWeight: 650,
    letterSpacing: "-.035em",
    lineHeight: 1.2
  },
  eyebrow: {
    margin: 0,
    fontSize: 10,
    letterSpacing: ".16em",
    fontWeight: 600,
    color: "var(--form-accent)"
  },
  heading: {
    margin: 0,
    fontSize: 15,
    fontWeight: 650
  },
  description: {
    margin: "4px 0 18px",
    color: "var(--form-muted)",
    fontSize: 12
  },
  previewCaption: {
    marginBottom: 8,
    color: "var(--form-muted)",
    fontSize: 9,
    letterSpacing: ".12em"
  },
};

export function SettingComponent (props: Props) {
  const [state, setState] = React.useState<ISetting>({...Setting.get() });

  React.useEffect(() => {
    Emit.on("app:setting", onAppSetting);
    Emit.send("app:init");

    return () => {
      Emit.off("app:setting", onAppSetting);
    };
  }, []);

  function onAppSetting (state: ISetting) {
    setState(() => state);
  }

  function onToggleType (e: React.ChangeEvent<HTMLInputElement>) {
    setState(state => {
      const type = e.target.value as ISetting["type"];
      const path = state.path;
      const { presets, searchengines, ...rest } = state.presets[`[${type}]:${path}`] || { type, path };

      return { ...state, ...rest };
    });
  }

  function onChangePath (e: React.ChangeEvent<HTMLInputElement>) {
    setState(state => {
      const path = e.target.value;
      const type = state.type;
      const { presets, searchengines, ...rest } = state.presets[`[${type}]:${path}`] || { type, path };

      return { ...state, ...rest };
    });
  }

  function onChangeFont (e: React.ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, font: { ...state.font, size: +e.target.value } }));
  }

  function onChangeLspace (e: React.ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, font: { ...state.font, lspace: +e.target.value } }));
  }

  function onChangeOpacity (e: React.ChangeEvent<HTMLInputElement>) {
    setState(state => ({ ...state, opacity: +e.target.value }));
  }

  function onToggleOption (e: React.ChangeEvent<HTMLInputElement>) {
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

  function onSubmit (e: React.FormEvent) {
    const { type, path, font, opacity, options, bookmarks, searchengines, acp } = state;

    e.stopPropagation();
    e.preventDefault();

    Setting.type = type;
    Setting.path = path;
    Setting.font = { size: font.size, width: Math.floor(font.size * 0.6), height: font.size + font.lspace, lspace: font.lspace, scale: Math.ceil(window.devicePixelRatio) };
    Setting.opacity = opacity;
    Setting.options = options;
    Setting.bookmarks = bookmarks;
    Setting.searchengines = searchengines;
    Setting.acp = acp;

    Emit.send("neovim:connect", Setting.get(), bookmarks.find(({ selected }) => selected)?.path);
  }

  const connectionLabels = { command: "Command", address: "Server", docker: "Docker", ssh: "SSH" };

  function renderSection(id: string, title: string, description: string, children: React.ReactNode, full = false) {
    return (
      <section aria-labelledby={id} style={{ minWidth: 0, flex: full ? "1 1 100%" : "1 1 calc(50% - 8px)" }}>
        <FlexComponent direction="column" color="default" border={[1]} rounded={[10]} padding={[22]} overflow="visible" whiteSpace="pre-wrap" style={{ height: "100%", borderColor: "var(--form-border)", wordBreak: "normal" }}>
          <h2 style={styles.heading} id={id}>{title}</h2>
          <p style={styles.description}>{description}</p>
          {children}
        </FlexComponent>
      </section>
    );
  }

  return (
    <FlexComponent direction="column" color="inverse-fg" overflow="auto" padding={[48, 28, 28]} whiteSpace="pre-wrap" style={{ ...styles.scope, ...props }}>
      <FlexComponent color="default" position="fixed" inset={[0]} zIndex={-1} nomouse style={{ opacity: (100 - state.opacity) / 100 }} />
      <form style={{ width: "100%", maxWidth: 880, margin: "0 auto" }} onSubmit={onSubmit}>
        <header>
          <FlexComponent vertical="center" margin={[0, 0, 28]} overflow="visible" whiteSpace="pre-wrap" style={{ gap: 18, wordBreak: "normal" }}>
            <img src={envimIconUrl} alt="" width={56} height={56} draggable={false} style={{ flexShrink: 0, objectFit: "contain" }} />
            <div>
              <p style={styles.eyebrow}>YOUR NEOVIM WORKSPACE</p>
              <h1 style={{ ...styles.title, fontSize: 27 }}>Welcome to Envim</h1>
            </div>
          </FlexComponent>
        </header>

        <FlexComponent overflow="visible" style={{ flexWrap: "wrap", gap: 16 }}>
          {renderSection("connection-title", "Connection", "Choose how to connect to Neovim.", <>
            <div role="group" aria-label="Connection type">
              <FlexComponent margin={[0, 0, 18]} overflow="visible" style={{ flexWrap: "wrap", gap: 6 }}>
                {Object.entries(connectionLabels).map(([type, label]) => (
                  <label key={type}><input type="radio" name="connection-type" value={type} checked={state.type === type} onChange={onToggleType} />{label}</label>
                ))}
              </FlexComponent>
            </div>
            <label>Neovim path<input type="text" value={state.path} onChange={onChangePath} autoFocus spellCheck={false} /></label>
          </>, true)}

          {renderSection("appearance-title", "Appearance", "Fine-tune your editor’s reading comfort.", <>
            <label><span>Font size <output>{state.font.size}px</output></span><input type="range" min="5" max="20" value={state.font.size} onChange={onChangeFont} /></label>
            <label><span>Line spacing <output>{state.font.lspace}px</output></span><input type="range" min="0" max="10" value={state.font.lspace} onChange={onChangeLspace} /></label>
            <FlexComponent direction="column" color="inverse" padding={[12, 14]} margin={[0, 0, 16]} rounded={[6]} whiteSpace="pre-wrap">
              <span style={styles.previewCaption}>PREVIEW</span>
              <div style={{ color: "var(--color-fg)", fontFamily: '"Regular", monospace', overflowWrap: "anywhere", fontSize: state.font.size, lineHeight: `${state.font.size + state.font.lspace}px` }}>
                The quick brown fox<br />
                jumps over the lazy dog.
              </div>
              </FlexComponent>
            <label><span>Transparency <output>{state.opacity}%</output></span><input type="range" min="0" max="50" value={state.opacity} onChange={onChangeOpacity} /></label>
          </>)}

          {renderSection("options-title", "Options", "Choose the Neovim UI features to enable.",
            <FlexComponent direction="column" overflow="visible" style={{ fontFamily: '"Regular", monospace' }}>
              {Object.keys(state.options).map(key => (
                <label key={key}><input type="checkbox" name={key} checked={state.options[key]} onChange={onToggleOption} />{key}</label>
              ))}
            </FlexComponent>
          )}

          {renderSection("bookmarks-title", "Bookmarks", "Pick a workspace to open.",
            <FlexComponent direction="column" overflow="auto" style={{ maxHeight: 180 }}>
              <label><input type="radio" name="bookmark" checked={!state.bookmarks.some(({ selected }) => selected)} onChange={() => onSelectBookmark(-1)} />Default workspace</label>
              {state.bookmarks.map((bookmark, i) => (
                <label key={i}><input type="radio" name="bookmark" checked={bookmark.selected} onChange={() => onSelectBookmark(i)} />{bookmark.name.replace(/\//g, " / ")}</label>
              ))}
            </FlexComponent>
          )}

          {renderSection("presets-title", "Presets", "Reuse a saved connection setup.",
            <FlexComponent direction="column" overflow="auto" style={{ maxHeight: 180 }}>
              {Object.keys(state.presets).length === 0 && <span style={{ color: "var(--form-muted)" }}>No saved presets yet.</span>}
              {Object.keys(state.presets).map(key => (
                <label key={key}><input type="radio" name="preset" checked={`[${state.type}]:${state.path}` === key} onChange={() => onSelectPreset(key)} />{key}</label>
              ))}
            </FlexComponent>
          )}
        </FlexComponent>

        <footer>
          <FlexComponent vertical="center" padding={[20, 0, 4]} overflow="visible">
            <span style={{ color: "var(--form-muted)", fontSize: 12 }}>Ready when you are.</span>
            <FlexComponent grow={1} />
            <button type="submit">Start Envim</button>
          </FlexComponent>
        </footer>
      </form>
    </FlexComponent>
  );
}
