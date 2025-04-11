import React, { useEffect, useState, MouseEvent, DragEvent } from "react";

import { ISetting, ITab, IMode, IMenu } from "../../../common/interface";

import { useEditor } from "../../context/editor";

import { Emit } from "../../utils/emit";
import { Setting } from "../../utils/setting";
import { icons } from "../../utils/icons";

import { FlexComponent } from "../flex";
import { IconComponent } from "../icon";
import { MenuComponent } from "../menu";

interface Props {
  width: number;
  height: number;
  paddingLeft: number;
}

interface States {
  cwd: string;
  tabs: ITab[];
  menus: IMenu[];
  bookmarks: ISetting["bookmarks"];
  connections: string[];
  mode?: IMode;
  dragging: number;
  enabled: boolean;
}

const styles = {
  tab: {
    width: 150,
    minWidth: "2rem",
    cursor: "pointer",
  },
};

export function TablineComponent(props: Props) {
  const { options, mode, tabs, menus  } = useEditor();
  const [state, setState] = useState<States>({ cwd: "", tabs, menus, bookmarks: [], connections: [], dragging: -1, enabled: options.ext_tabline });

  useEffect(() => {
    Emit.on("envim:cwd", onCwd);
    Emit.on("envim:connections", onConnections);

    return () => {
      Emit.off("envim:cwd", onCwd);
      Emit.off("envim:connections", onConnections);
    };
  }, []);

  function onCwd(cwd: string) {
    const bookmarks = Setting.bookmarks;
    const current = bookmarks.find(({ selected }) => selected);
    const selected = bookmarks
      .filter(({ path }) => cwd.indexOf(path) === 0)
      .sort((a, b) => a.path.length - b.path.length)
      .pop();
    Setting.bookmarks = bookmarks.map(bookmark => ({ ...bookmark, selected: bookmark === selected }));

    setState(state => ({ ...state, cwd, bookmarks: Setting.bookmarks }));
    selected && current !== selected && Emit.send("envim:connect", Setting.type, Setting.path, selected.path);
  }

  function onConnections (connections: string[]) {
    setState(state => ({ ...state, connections }));
  }

  async function saveBookmark(path: string) {
    if (path !== state.cwd) {
      path = await Emit.send<string>("envim:readline", "Bookmark Path", state.cwd, "dir") || path;
    }

    const bookmark = state.bookmarks.find(bookmark => bookmark.path === path);
    const bookmarks = state.bookmarks
      .filter(bookmark => bookmark.path !== path)
      .map(bookmark => ({ ...bookmark, selected: false }));
    const name = await Emit.send<string>("envim:readline", "Bookmark Name", bookmark?.name || state.cwd);

    if (name) {
      bookmarks.push({ name: name.replace(/^\//, "").replace(/\/+/, "/").replace(/\/$/, ""), path, selected: false });
      Setting.bookmarks = bookmarks.sort((a, b) => a.name > b.name ? 1 : -1);

      onCwd(path);
    }
  }

  function deleteBookmark(e: MouseEvent, path: string) {
    const bookmarks = state.bookmarks.filter(bookmark => bookmark.path !== path);

    e.stopPropagation();
    e.preventDefault();

    Setting.bookmarks = bookmarks;
    setState(state => ({ ...state, bookmarks }));
  }

  function runCommand(e: MouseEvent, command: string) {
    e.stopPropagation();
    e.preventDefault();

    Emit.send("envim:command", command);
  }

  useEffect(() => {
    setState(state => ({ ...state, tabs }));
  }, [tabs]);

  useEffect(() => {
    setState(state => ({ ...state, menus }));
  }, [menus]);

  useEffect(() => {
    setState(state => ({ ...state, mode }));
  }, [mode]);

  useEffect(() => {
    options.ext_tabline === undefined || setState(state => ({ ...state, enabled: options.ext_tabline }));
  }, [options.ext_tabline]);

  function renderTab(i: number, tab: ITab) {
    const icon = icons.filter(icon => (tab.filetype || "").search(icon.type) >= 0 || (tab.buftype || "").search(icon.type) >= 0).shift();

    function onDragStart() {
      setState(state => ({ ...state, dragging: i }));
    }

    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }

    function onDragEnd() {
      setState(state => ({ ...state, dragging: -1 }));
    }

    function onDrop(e: DragEvent) {
      const next = i - state.dragging;

      if (next) {
        const prev = state.dragging + 1;
        const sign = next < 0 ? "-" : "+";
        const curr = state.tabs.findIndex(tab => tab.active) + 1;
        const offset = (() => {
          if (state.dragging < curr - 1 && i >= curr - 1) return -1;
          if (state.dragging > curr - 1 && i <= curr - 1) return 1;
          return 0;
        })();
        const prevCommand = prev === curr ? "" : `tabnext ${prev} |`;
        const nextCommand = prev === curr ? "" : `| tabnext ${curr + offset}`;

        runCommand(e, `${prevCommand} tabmove ${sign}${Math.abs(next)} ${nextCommand}`);;
      }
    }

    return !icon ? null : (
      <FlexComponent key={i} animate="fade-in hover" color={icon.color} active={tab.active} title={tab.name} shrink={tab.active ? 0 : 2} margin={[4, 2, 0]} padding={[0, 8]} rounded={[4, 4, 0, 0]} shadow={tab.active} style={styles.tab} onClick={e => runCommand(e, `tabnext ${i + 1}`)} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDrop={onDrop} >
        <IconComponent font={icon.font} text={tab.name.replace(/.*\//, "…/")} />
        { state.tabs.length > 1 && <IconComponent color="gray" font="" float="right" onClick={e => runCommand(e, `confirm tabclose ${i + 1}`)} hover /> }
      </FlexComponent>
    );
  }

  function renderSubmenu(menus: IMenu[], base: string[]) {
    const sname = state.mode?.short_name;

    return !sname ? null : menus.map((menu, i) => {
      const command = [ ...base, menu.name.replace(/([\. ])/g, "\\$1") ];

      return menu.submenus?.length ? (
        <MenuComponent key={i} side={base.length > 0} label={menu.name}>
          { renderSubmenu(menu.submenus, command)}
        </MenuComponent>
      ) : (
        menu.mappings[sname]?.enabled && menu.mappings[sname]?.rhs
          ? <FlexComponent key={i} onClick={e => runCommand(e, `emenu ${command.join(".")}`)} spacing>{ menu.name }</FlexComponent>
          : <FlexComponent key={i} color="gray-fg" spacing>{ menu.name }</FlexComponent>
      );
    });
  }

  function renderBookmark() {
    const bookmark = state.bookmarks.find(({ selected }) => selected);
    const text = bookmark && bookmark.name.split("/").pop() || "";
    const icon = bookmark ? { color: "blue-fg", font: "", text } : { color: "gray-fg", font: "", text };

    return <IconComponent { ...icon } onClick={() => saveBookmark(bookmark?.path || state.cwd)} />;
  }

  function renderBookmarkMenu(base: string) {
    const regexp = new RegExp(`^${base}`);
    const bookmarks = state.bookmarks.filter(({ name }) => name.match(regexp)).map(({ name, ...other }) => ({ ...other, name: name.replace(regexp, "") }));
    const groups = bookmarks.map(({ name }) => name.split("/")).reduce((all, curr) => curr.length === 1 || all.indexOf(curr[0]) >= 0 ? all : [...all, curr[0]], []);
    const selected = state.bookmarks.find(({ selected }) => selected)?.name || "";

    return (
      <>
        { groups.map(group =>
          <MenuComponent key={`${base}${group}`} color="lightblue-fg" label={`󰉋 ${group}`} active={selected.indexOf(`${base}${group}/`) === 0} side>
            { renderBookmarkMenu(`${base}${group}/`) }
          </MenuComponent>
        ) }
        { bookmarks.filter(({ name }) => name.split("/").length === 1).map(({ name, path, selected }, i) =>
          <FlexComponent animate="hover" direction="column" active={selected} key={`${base}-${i}`} onClick={e => runCommand(e, `cd ${path}`)} spacing>
            <FlexComponent>{ state.connections.includes(path) && <IconComponent color="green-fg" font="" /> }{name}</FlexComponent>
            <div className="color-gray-fg small">{ path }</div>
            <IconComponent color="gray" font="" float="right" onClick={e => deleteBookmark(e, path)} hover />
          </FlexComponent>
        ) }
      </>
    );
  }

  return (
    <FlexComponent color="default" overflow="visible" zIndex={1} style={props} shadow>
      {state.enabled && state.tabs.map((tab, i) => renderTab(i, tab))}
      <IconComponent color="green-fg" font="" onClick={e => runCommand(e, "$tab split")} />
      <MenuComponent color="lightblue-fg" label="󰉋">
        { renderBookmarkMenu("") }
      </MenuComponent>
      { renderBookmark() }
      <div className="space dragable" />
      { renderSubmenu(state.menus, []) }
      <IconComponent color="gray-fg" font="" onClick={e => runCommand(e, "confirm quitall")} />
    </FlexComponent>
  );
}
