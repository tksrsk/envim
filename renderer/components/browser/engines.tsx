import React from "react";

import { useWorkspace } from "renderer/context/workspace";
import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { uiIcons } from "renderer/utils/icons";
import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { MenuComponent } from "renderer/components/menu";

export function useSearchEngines() {
  const [engines, setEngines] = React.useState(Setting.searchengines);

  React.useEffect(() => {
    const onEngines = () => setEngines(Setting.searchengines);
    Emit.on("browser:searchengines", onEngines);
    return () => Emit.off("browser:searchengines", onEngines);
  }, []);

  function save(next: typeof engines) {
    Setting.searchengines = next;
    Emit.share("browser:searchengines");
  }

  return { engines, save };
}

interface Props extends ReturnType<typeof useSearchEngines> {
  url: string;
  onNavigate: (uri: string) => void;
  onFocusAddress: () => void;
}

export function SearchEngineMenuComponent({ url, engines, save, onNavigate, onFocusAddress }: Props) {
  const { emit } = useWorkspace();
  const icon = engines.some(({ uri }) => uri === url)
    ? { font: "", color: "blue-fg" }
    : { font: "", color: "gray-fg" };

  async function saveEngine() {
    const uri = await emit.send<string>("neovim:readline", "URI", url);
    if (!uri) return;
    const name = await emit.send<string>("neovim:readline", "Name", engines.find(engine => engine.uri === uri)?.name || "");
    if (!name) return;
    const selected = uri.includes("${query}");
    save([
      ...engines.filter(engine => engine.name !== name && engine.uri !== uri).map(engine => ({ ...engine, selected: engine.selected && !selected })),
      { name, uri, selected },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function renderEngines(prefix = ""): React.ReactNode {
    const items = engines.filter(item => item.name.startsWith(prefix));
    const groups = new Set(items.map(item => item.name.slice(prefix.length).split("/")).filter(parts => parts.length > 1).map(parts => parts[0]));
    return <>
      {[...groups].map(group => (
        <MenuComponent key={group} color="lightblue-fg" label={`󰉋 ${group}`} active={items.some(item => item.selected && item.name.startsWith(`${prefix}${group}/`))} side>
          {renderEngines(`${prefix}${group}/`)}
        </MenuComponent>
      ))}
      {items.filter(item => !item.name.slice(prefix.length).includes("/")).map(engine => (
        <FlexComponent key={engine.name} animate="hover" active={engine.selected} spacing onClick={event => {
          if (engine.uri.includes("${query}")) {
            save(engines.map(item => ({ ...item, selected: item.name === engine.name })));
            onFocusAddress();
          } else if (event.ctrlKey || event.metaKey) {
            void emit.send("browser:open", engine.uri);
          } else onNavigate(engine.uri);
        }}>
          {engine.name.slice(prefix.length)}
          <IconComponent color="gray" font={uiIcons.close} float="right" onClick={() => save(engines.filter(item => item !== engine))} hover />
        </FlexComponent>
      ))}
    </>;
  }

  return (
    <MenuComponent label={() => <IconComponent {...icon} onClick={() => void saveEngine()} />}>
      <FlexComponent direction="column">
        {renderEngines()}
        <FlexComponent spacing onClick={() => void saveEngine()}>Add</FlexComponent>
      </FlexComponent>
    </MenuComponent>
  );
}
