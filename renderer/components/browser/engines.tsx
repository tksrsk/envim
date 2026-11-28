import React from "react";
import { ActionIcon } from "@mantine/core";

import { IFormRequest, schema } from "common/schema";

import { useWorkspace } from "renderer/context/workspace";
import { useApp } from "renderer/context/app";
import { uiIcons } from "renderer/utils/icons";
import { MenuComponent, MenuItemComponent, TreeMenuItems } from "renderer/components/menu";

export function useSearchEngines() {
  const { setting: { searchengines: engines }, updateSetting } = useApp();

  function save(update: (current: typeof engines) => typeof engines) {
    updateSetting(setting => ({ ...setting, searchengines: update(setting.searchengines) }));
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
    ? { font: "", color: "blue" }
    : { font: "", color: "gray" };

  React.useEffect(() => {
    emit.on("searchengine:save", onEngineSave);
    return () => emit.off("searchengine:save", onEngineSave);
  }, [emit]);

  function onEngineSave(original: string | undefined, action?: string, values?: { name: string; uri: string }) {
    if (action !== "delete" && (action !== "save" || !values)) return;

    save(current => {
      const others = current.filter(engine => ![original, values?.name].includes(engine.name) && engine.uri !== values?.uri);
      const selected = !!values?.uri.includes("${query}");
      const next = action === "save" && values
        ? [...others.map(engine => ({ ...engine, selected: engine.selected && !selected })), { name: values.name, uri: values.uri, selected }]
        : others;
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  function openEngineForm(e: React.MouseEvent, engine?: typeof engines[number]) {
    e.stopPropagation();

    emit.share("form:open", {
      title: `${uiIcons.search} Search engine`,
      schema: schema.object({ name: schema.string("Name"), uri: schema.string("URI", { description: "Use ${query} for the search terms" }) }, ["name", "uri"]),
      values: engine ?? { name: "", uri: url },
      actions: [
        { action: "save", name: "Save", color: "blue", font: uiIcons.save, submit: true },
        ...(engine ? [{ action: "delete", name: "Delete", color: "red", font: uiIcons.close }] : []),
      ],
      reply: { event: "searchengine:save", via: "share", args: [engine?.name] },
    } satisfies IFormRequest);
  }

  function renderEngine(engine: typeof engines[number], label: string) {
    return (
      <MenuItemComponent key={engine.name} active={engine.selected}
        rightSection={<ActionIcon title="Edit" onClick={e => openEngineForm(e, engine)}><i>{uiIcons.edit}</i></ActionIcon>}
        onClick={event => {
        if (engine.uri.includes("${query}")) {
          save(current => current.map(item => ({ ...item, selected: item.name === engine.name })));
          onFocusAddress();
        } else if (event.ctrlKey || event.metaKey) {
          void emit.send("browser:open", engine.uri);
        } else onNavigate(engine.uri);
      }}>
        {label}
      </MenuItemComponent>
    );
  }

  return (
    <MenuComponent label={() => <ActionIcon color={icon.color}><i>{icon.font}</i></ActionIcon>}>
      {query => <>
        <TreeMenuItems items={engines} query={query} text={({ uri }) => uri} active={({ selected }) => selected} render={renderEngine} />
        <MenuItemComponent leftSection={<i>{uiIcons.add}</i>} onClick={e => openEngineForm(e)}>Add</MenuItemComponent>
      </>}
    </MenuComponent>
  );
}
