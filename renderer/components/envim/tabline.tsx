import React from "react";
import { ActionIcon, Box, Button, Divider, Menu } from "@mantine/core";

import { ISetting, ITab, IMode, IMenu } from "common/interface";
import { IFormRequest, schema } from "common/schema";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";
import type { BrowserWorkspace } from "renderer/context/browser";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";
import { icons, uiIcons } from "renderer/utils/icons";

import { SurfaceSwitchComponent, WorkspaceTabComponent } from "renderer/components/tab";
import { BrowserTablineComponent } from "renderer/components/browser/tabline";
import { MenuComponent, SubMenuComponent, MenuItemComponent, MenuLabelComponent, TreeMenuItems } from "renderer/components/menu";

interface Props {
  height: number;
  paddingLeft: number;
  paddingRight: number;
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
  theme: "dark" | "light";
  historyOpen: boolean;
}

export function TablineComponent({ onToggleSurface, onFocusEditor, browserState, ...props }: Props) {
  const { options, mode, tabs, menus  } = useEditor();
  const { workspace, workspaces, emit } = useWorkspace();
  const [state, setState] = React.useState<States>({ cwd: "", tabs, menus, bookmarks: [], dragging: -1, enabled: options.ext_tabline, theme: "dark", historyOpen: false });

  React.useEffect(() => {
    emit.on("neovim:cwd", onNeovimCwd);
    emit.on("history:visibility", onHistoryVisibility);
    emit.on("bookmark:save", onBookmarkSave);

    return () => {
      emit.off("neovim:cwd", onNeovimCwd);
      emit.off("history:visibility", onHistoryVisibility);
      emit.off("bookmark:save", onBookmarkSave);
    };
  }, []);

  function onHistoryVisibility(historyOpen: boolean) {
    setState(state => ({ ...state, historyOpen }));
  }

  function toggleTheme() {
    setState(state => {
      const theme = state.theme === "dark" ? "light" : "dark";

      emit.send("neovim:command", `set background=${theme}`);

      return { ...state, theme };
    });
  }

  function onNeovimCwd(cwd: string) {
    setState(state => ({ ...state, cwd, bookmarks: Setting.bookmarks }));
  }

  function openBookmarkForm(e: React.MouseEvent, bookmark?: ISetting["bookmarks"][number]) {
    e.stopPropagation();

    emit.share("form:open", {
      title: " Bookmark",
      schema: schema.object({ name: schema.string("Name"), path: schema.string("Path") }, ["name", "path"]),
      values: bookmark ?? { name: state.cwd, path: state.cwd },
      actions: [
        { action: "save", name: "Save", color: "blue", font: uiIcons.save, submit: true },
        ...(bookmark ? [{ action: "delete", name: "Delete", color: "red", font: uiIcons.close }] : []),
      ],
      reply: { event: "bookmark:save", via: "share", args: [bookmark?.path] },
    } satisfies IFormRequest);
  }

  function onBookmarkSave(original: string | undefined, action?: string, values?: { name: string; path: string }) {
    const others = Setting.bookmarks.filter(bookmark => ![original, values?.path].includes(bookmark.path));
    const bookmarks = action === "save" && values
      ? [...others.map(bookmark => ({ ...bookmark, selected: false })), { name: values.name.replace(/^\//, "").replace(/\/+/, "/").replace(/\/$/, ""), path: values.path, selected: false }]
      : action === "delete" ? others : undefined;

    if (!bookmarks) return;

    Setting.bookmarks = bookmarks.sort((a, b) => a.name > b.name ? 1 : -1);
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

      const Submenu = base.length > 0 ? SubMenuComponent : MenuComponent;
      const Item = base.length > 0 ? MenuItemComponent : MenuLabelComponent;

      return menu.submenus?.length ? (
        <Submenu key={i} label={menu.name}>
          { renderSubmenu(menu.submenus, command)}
        </Submenu>
      ) : (
        <Item key={i} disabled={!(menu.mappings[sname]?.enabled && menu.mappings[sname]?.rhs)} onClick={(event: React.MouseEvent) => {
          onFocusEditor();
          runCommand(event, `emenu ${command.join(".")}`);
        }}>{ menu.name }</Item>
      );
    });
  }

  function renderBookmark() {
    const bookmark = state.bookmarks.find(({ path }) => path === workspace);
    const text = bookmark && bookmark.name.split("/").pop() || "";
    const color = bookmark ? "blue" : "gray";
    const font = <i>{bookmark ? "" : ""}</i>;
    return text
      ? <Button variant="subtle" color={color} size="compact-xs" className="envim-inline-button" leftSection={font}>{text}</Button>
      : <ActionIcon color={color}>{font}</ActionIcon>;
  }

  function renderBookmarkItem(bookmark: ISetting["bookmarks"][number], label: string) {
    const { path } = bookmark;

    return (
      <MenuItemComponent key={path} active={path === workspace} onClick={e => runCommand(e, `cd ${path}`)}
        leftSection={<Box component="i" c="green" style={{ visibility: Object.values(workspaces).includes(path) ? "visible" : "hidden" }}>{uiIcons.connected}</Box>}
        rightSection={<ActionIcon title="Edit" onClick={e => openBookmarkForm(e, bookmark)}><i>{uiIcons.edit}</i></ActionIcon>}
      >
        <div>{label}</div>
        <Box c="dimmed" fz="xs">{ path }</Box>
      </MenuItemComponent>
    );
  }

  return (
    <div className="envim-tabline" style={props}>
      <SurfaceSwitchComponent onClick={onToggleSurface} />
      {browserState
        ? <BrowserTablineComponent state={browserState} />
        : <>
          {state.enabled && state.tabs.map((tab, i) => renderTab(i, tab))}
          <ActionIcon color="green" onClick={e => runCommand(e, "$tab split")}><i>{uiIcons.add}</i></ActionIcon>
        </>}
      <MenuComponent label={renderBookmark}>
        { query => <>
          <TreeMenuItems items={state.bookmarks} query={query} text={({ path }) => path} active={({ path }) => path === workspace} render={renderBookmarkItem} />
          <MenuItemComponent leftSection={<i>{uiIcons.add}</i>} onClick={e => openBookmarkForm(e)}>Add</MenuItemComponent>
        </> }
      </MenuComponent>
      <div className="space dragable" />
      { renderSubmenu(state.menus, []) }
      <Divider orientation="vertical" mx={6} my={8} />
      <ActionIcon color="violet" title="Agent" aria-label="Agent" onClick={() => emit.send("acp:toggle")}><i>{uiIcons.agent}</i></ActionIcon>
      <MenuComponent label={() => <ActionIcon title="Settings" aria-label="Settings"><i>{uiIcons.settings}</i></ActionIcon>}>
        <Menu.CheckboxItem checked={state.historyOpen} onChange={checked => emit.share("history:toggle", checked)}>Message history</Menu.CheckboxItem>
        <Menu.Divider />
        { ["ext_tabline", "ext_cmdline", "ext_messages", "ext_popupmenu", "ext_termcolors"].map(ext => (
          <Menu.CheckboxItem key={ext} checked={!!options[ext]} onChange={checked => emit.send("neovim:ui:option", ext, checked)}>{ ext }</Menu.CheckboxItem>
        )) }
        <Menu.Divider />
        <MenuItemComponent closeMenuOnClick={false} onClick={toggleTheme}
          leftSection={<Box component="i" c={state.theme === "light" ? "orange" : "yellow"}>{state.theme === "light" ? "" : ""}</Box>}>
          {state.theme === "light" ? "Light" : "Dark"}
        </MenuItemComponent>
        <Menu.Divider />
        <MenuItemComponent color="red" leftSection={<i>{uiIcons.quit}</i>} onClick={e => runCommand(e, "confirm quitall")}>Quit all</MenuItemComponent>
      </MenuComponent>
    </div>
  );
}
