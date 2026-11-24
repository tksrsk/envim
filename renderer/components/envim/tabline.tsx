import React from "react";

import { ISetting, ITab, IMode, IMenu } from "common/interface";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";
import type { BrowserWorkspace } from "renderer/context/browser";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { icons, uiIcons } from "renderer/utils/icons";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { SurfaceSwitchComponent, WorkspaceTabComponent } from "renderer/components/tab";
import { BrowserTablineComponent } from "renderer/components/browser/tabline";
import { MenuComponent } from "renderer/components/menu";

interface Props {
  width: number;
  height: number;
  paddingLeft: number;
  onToggleSurface: () => void;
  onFocusEditor: () => void;
  browserState?: BrowserWorkspace;
}

interface States {
  cwd: string;
  tabs: ITab[];
  menus: IMenu[];
  bookmarks: ISetting["bookmarks"];
  mode?: IMode;
  dragging: number;
  enabled: boolean;
}

export function TablineComponent({ onToggleSurface, onFocusEditor, browserState, ...props }: Props) {
  const { options, mode, tabs, menus  } = useEditor();
  const { workspace, workspaces, emit } = useWorkspace();
  const [state, setState] = React.useState<States>({ cwd: "", tabs, menus, bookmarks: [], dragging: -1, enabled: options.ext_tabline });

  React.useEffect(() => {
    emit.on("neovim:cwd", onNeovimCwd);

    return () => {
      emit.off("neovim:cwd", onNeovimCwd);
    };
  }, []);

  function onNeovimCwd(cwd: string) {
    setState(state => ({ ...state, cwd, bookmarks: Setting.bookmarks }));
  }

  async function saveBookmark(path: string) {
    if (path !== state.cwd) {
      path = await emit.send<string>("neovim:readline", "Bookmark Path", state.cwd, "dir") || path;
    }

    const bookmark = state.bookmarks.find(bookmark => bookmark.path === path);
    const bookmarks = state.bookmarks
      .filter(bookmark => bookmark.path !== path)
      .map(bookmark => ({ ...bookmark, selected: false }));
    const name = await emit.send<string>("neovim:readline", "Bookmark Name", bookmark?.name || state.cwd);

    if (name) {
      bookmarks.push({ name: name.replace(/^\//, "").replace(/\/+/, "/").replace(/\/$/, ""), path, selected: false });
      Setting.bookmarks = bookmarks.sort((a, b) => a.name > b.name ? 1 : -1);

      Emit.send("app:setting", Setting.get());
      setState(state => ({ ...state, bookmarks }));
    }
  }

  function deleteBookmark(e: React.MouseEvent, path: string) {
    const bookmarks = state.bookmarks.filter(bookmark => bookmark.path !== path);

    e.stopPropagation();
    e.preventDefault();

    Setting.bookmarks = bookmarks;
    Emit.send("app:setting", Setting.get());
    setState(state => ({ ...state, bookmarks }));
  }

  function runCommand(e: React.MouseEvent, command: string) {
    e.stopPropagation();
    e.preventDefault();

    emit.send("neovim:command", command);
  }

  React.useEffect(() => {
    setState(state => ({ ...state, tabs }));
  }, [tabs]);

  React.useEffect(() => {
    setState(state => ({ ...state, menus }));
  }, [menus]);

  React.useEffect(() => {
    setState(state => ({ ...state, mode }));
  }, [mode]);

  React.useEffect(() => {
    options.ext_tabline === undefined || setState(state => ({ ...state, enabled: options.ext_tabline }));
  }, [options.ext_tabline]);

  function renderTab(i: number, tab: ITab) {
    const icon = icons.find(icon => tab.name.match(icon.match))!;

    function onDragStart() {
      setState(state => ({ ...state, dragging: i }));
    }

    function onDragOver(e: React.DragEvent) {
      e.preventDefault();
    }

    function onDragEnd() {
      setState(state => ({ ...state, dragging: -1 }));
    }

    function onDrop(e: React.DragEvent) {
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

        runCommand(e, `${prevCommand} tabmove ${sign}${Math.abs(next)} ${nextCommand}`);
      }
    }

    return (
      <WorkspaceTabComponent key={i} color={icon.color} active={tab.active} title={tab.name}
        font={icon.font} text={tab.name.replace(/.*\//, "…/")}
        onClick={event => runCommand(event, `tabnext ${i + 1}`)}
        onClose={state.tabs.length > 1 ? event => runCommand(event, `confirm tabclose ${i + 1}`) : undefined}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDrop={onDrop} />
    );
  }

  function renderSubmenu(menus: IMenu[], base: string[]) {
    const sname = state.mode?.short_name;

    return !sname ? null : menus.map((menu, i) => {
      const command = [ ...base, menu.name.replace(/([\\. ])/g, "\\$1") ];

      return menu.submenus?.length ? (
        <MenuComponent key={i} side={base.length > 0} label={menu.name}>
          { renderSubmenu(menu.submenus, command)}
        </MenuComponent>
      ) : (
        menu.mappings[sname]?.enabled && menu.mappings[sname]?.rhs
          ? <FlexComponent key={i} onClick={event => {
            onFocusEditor();
            runCommand(event, `emenu ${command.join(".")}`);
          }} spacing>{ menu.name }</FlexComponent>
          : <FlexComponent key={i} color="gray-fg" spacing>{ menu.name }</FlexComponent>
      );
    });
  }

  function renderBookmark() {
    const bookmark = state.bookmarks.find(({ path }) => path === workspace);
    const text = bookmark && bookmark.name.split("/").pop() || "";
    const icon = bookmark ? { color: "blue-fg", font: "", text } : { color: "gray-fg", font: "", text };

    return <IconComponent { ...icon } onClick={() => saveBookmark(bookmark?.path || state.cwd)} />;
  }

  function renderBookmarkMenu(base: string) {
    const regexp = new RegExp(`^${base}`);
    const bookmarks = state.bookmarks.filter(({ name }) => name.match(regexp)).map(({ name, ...other }) => ({ ...other, name: name.replace(regexp, "") }));
    const groups = bookmarks.map(({ name }) => name.split("/")).reduce((all, curr) => curr.length === 1 || all.indexOf(curr[0]) >= 0 ? all : [...all, curr[0]], []);
    const selected = state.bookmarks.find(({ path }) => path === workspace)?.name || "";

    return (
      <>
        { groups.map(group =>
          <MenuComponent key={`${base}${group}`} color="lightblue-fg" label={`󰉋 ${group}`} active={selected.indexOf(`${base}${group}/`) === 0} side>
            { renderBookmarkMenu(`${base}${group}/`) }
          </MenuComponent>
        ) }
        { bookmarks.filter(({ name }) => name.split("/").length === 1).map(({ name, path }, i) =>
          <FlexComponent animate="hover" direction="column" active={path === workspace} key={`${base}-${i}`} onClick={e => runCommand(e, `cd ${path}`)} spacing>
            <FlexComponent>{ Object.values(workspaces).includes(path) && <IconComponent color="green-fg" font="" /> }{name}</FlexComponent>
            <div className="color-gray-fg small">{ path }</div>
            <IconComponent color="gray" font={uiIcons.close} float="right" onClick={e => deleteBookmark(e, path)} hover />
          </FlexComponent>
        ) }
      </>
    );
  }

  return (
    <FlexComponent color="default" overflow="visible" zIndex={1} style={props} shadow>
      <SurfaceSwitchComponent onClick={onToggleSurface} />
      {browserState
        ? <BrowserTablineComponent state={browserState} />
        : <>
          {state.enabled && state.tabs.map((tab, i) => renderTab(i, tab))}
          <IconComponent color="green-fg" font={uiIcons.add} onClick={e => runCommand(e, "$tab split")} />
        </>}
      <MenuComponent label={renderBookmark}>
        { renderBookmarkMenu("") }
      </MenuComponent>
      <div className="space dragable" />
      { renderSubmenu(state.menus, []) }
      <IconComponent color="gray-fg" font={uiIcons.stop} onClick={e => runCommand(e, "confirm quitall")} />
    </FlexComponent>
  );
}
