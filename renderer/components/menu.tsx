import React from "react";
import { Menu, UnstyledButton } from "@mantine/core";


interface Props {
  label: string | (() => React.ReactNode);
  color?: string;
  active?: boolean;
}

interface MenuProps extends Props {
  children?: React.ReactNode | ((query: string) => React.ReactNode);
}

const openMenus = new Set<HTMLDivElement>();
export const menuLayoutEvent = "envim:menu-layout";

export function menuOverlaps(bounds: DOMRectReadOnly): boolean {
  for (const menu of openMenus) {
    const rect = menu.getBoundingClientRect();
    if (rect.left < bounds.right && rect.right > bounds.left &&
        rect.top < bounds.bottom && rect.bottom > bounds.top) return true;
  }
  return false;
}

export function trackMenu(element: HTMLDivElement) {
  const notify = () => document.dispatchEvent(new Event(menuLayoutEvent));
  const observer = new ResizeObserver(notify);

  openMenus.add(element);
  observer.observe(element);
  notify();

  return () => {
    observer.disconnect();
    openMenus.delete(element);
    notify();
  };
}

function hasContent(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some(child =>
    React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment
      ? hasContent(child.props.children)
      : true
  );
}

const dropdownStyle: React.CSSProperties = { maxHeight: "50vh", maxWidth: "50vw", overflowY: "auto" };
const activeStyle: React.CSSProperties = { background: "var(--mantine-primary-color-light)" };

export function MenuLabelComponent({ color, active, ...props }: Omit<React.ComponentProps<"button">, "color"> & { color?: string; active?: boolean }) {
  return <UnstyledButton {...props} className="menu-label" c={color} data-active={active || undefined} />;
}

export function MenuComponent({ label, color, active, children }: MenuProps) {
  const [opened, setOpened] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const search = React.useRef<HTMLInputElement>(null);
  const force = React.useRef(false);
  const searchable = typeof children === "function";
  const content = searchable ? children(query.trim().toLowerCase()) : children;

  React.useEffect(() => {
    const dropdown = search.current?.closest("[data-menu-dropdown]");
    const first = query.trim() && [...dropdown?.querySelectorAll("[data-menu-item]:not([data-disabled])") ?? []]
      .find(item => item.closest("[data-menu-dropdown]") === dropdown);

    first && first.setAttribute("data-menu-active", "true");
  }, [query]);

  function onChange(next: boolean) {
    if (!next && !force.current && document.activeElement === search.current) return;
    force.current = false;
    setOpened(next);
  }

  function close() {
    force.current = true;
    onChange(false);
  }

  return (
    <Menu opened={opened} onChange={onChange} disabled={!searchable && !hasContent(children)} trigger="hover" openDelay={150} closeDelay={250} position="bottom-start" shadow="md" trapFocus={false} returnFocus={false}>
      <Menu.Target>
        <div style={{ display: "flex", alignItems: "center", alignSelf: "center", flexShrink: 0 }}>
          {typeof label === "string"
            ? <MenuLabelComponent color={color} active={active}>{label}</MenuLabelComponent>
            : label()}
        </div>
      </Menu.Target>
      <Menu.Dropdown ref={trackMenu} style={dropdownStyle} onClickCapture={() => { force.current = true; queueMicrotask(() => force.current = false); }}>
        {searchable && <Menu.Search ref={search} size="xs" placeholder="Search" value={query} onChange={e => setQuery(e.currentTarget.value)}
          onKeyDown={e => e.key === "Escape" && close()}
          onBlur={e => (e.relatedTarget as HTMLElement | null)?.closest("[data-menu-dropdown]") || close()} />}
        {content}
      </Menu.Dropdown>
    </Menu>
  );
}

export function TreeMenuItems<T extends { name: string }>({ items, query, text, active, render }: {
  items: T[];
  query: string;
  text?: (item: T) => string;
  active?: (item: T) => boolean;
  render: (item: T, label: string) => React.ReactNode;
}) {
  if (query) {
    return <>{items.filter(item => `${item.name}\n${text?.(item) ?? ""}`.toLowerCase().includes(query)).map(item => render(item, item.name))}</>;
  }

  return renderTree(items, "", active, render);
}

function renderTree<T extends { name: string }>(items: T[], prefix: string, active: ((item: T) => boolean) | undefined, render: (item: T, label: string) => React.ReactNode): React.ReactNode {
  const scoped = items.filter(item => item.name.startsWith(prefix));
  const groups = new Set(scoped.map(item => item.name.slice(prefix.length).split("/")).filter(parts => parts.length > 1).map(parts => parts[0]));

  return <>
    {[...groups].map(group => (
      <SubMenuComponent key={`${prefix}${group}`} color="cyan" label={`󰉋 ${group}`} active={scoped.some(item => item.name.startsWith(`${prefix}${group}/`) && active?.(item))}>
        {renderTree(items, `${prefix}${group}/`, active, render)}
      </SubMenuComponent>
    ))}
    {scoped.filter(item => !item.name.slice(prefix.length).includes("/")).map(item => render(item, item.name.slice(prefix.length)))}
  </>;
}

export function SubMenuComponent({ label, color, active, leftSection, children }: React.PropsWithChildren<Props & { leftSection?: React.ReactNode }>) {
  return (
    <Menu.Sub disabled={!hasContent(children)} openDelay={100} closeDelay={200} floatingStrategy="fixed">
      <Menu.Sub.Target>
        <Menu.Sub.Item color={color} leftSection={leftSection} style={active ? activeStyle : undefined}>
          {typeof label === "string" ? label : label()}
        </Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown ref={trackMenu} style={dropdownStyle}>
        {children}
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}

type MenuItemProps = Omit<React.ComponentProps<"div">, "color"> & {
  active?: boolean;
  disabled?: boolean;
  color?: string;
  leftSection?: React.ReactNode;
  rightSection?: React.ReactNode;
  closeMenuOnClick?: boolean;
};

export function MenuItemComponent({ active, color, style, ...props }: MenuItemProps) {
  return <Menu.Item component="div" color={color} {...props} style={{ ...(active ? activeStyle : {}), ...style }} />;
}
