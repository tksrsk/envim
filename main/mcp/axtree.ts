import type * as Electron from "electron";

import { PageError } from "main/mcp/inject";
import { pageSelector } from "main/mcp/page";

const MAX_LINES = 500;
const MAX_CHARS = 30000;
const MAX_NAME = 200;
const MAX_TEXT = 1000;
const ISOLATED_WORLD = "envim-browser-tools";

// Roles that get a ref, so the agent can act on them. Focusable nodes get one as well.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "disclosuretriangle",
]);
// Roles that only group their children. They are skipped when they have no name.
const TRANSPARENT_ROLES = new Set([
  "none", "generic", "presentation", "InlineTextBox", "LineBreak", "LayoutTableCell", "LayoutTableRow", "LabelText", "MenuListPopup",
  // Text formatting. The text inside still appears.
  "strong", "emphasis", "mark", "subscript", "superscript", "deletion", "insertion",
]);
// Roles that structure the page. A focusable one, such as a heading with tabindex="-1", gets no ref.
const STRUCTURAL_ROLES = new Set([
  "heading", "paragraph", "article", "main", "region", "navigation", "banner", "contentinfo", "complementary", "search",
  "form", "list", "listitem", "table", "rowgroup", "row", "cell", "gridcell", "columnheader", "rowheader", "sectionheader",
  "separator", "status", "image", "img", "figure", "document", "group",
]);
const STATES = ["checked", "pressed", "selected", "expanded", "disabled", "required", "readonly", "invalid", "focused"];

interface AXValue {
  value?: unknown;
  sources?: { type: string; value?: unknown; superseded?: boolean }[];
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

// Debugger sessions are shared by concurrent tool calls on the same guest and detached when the last one ends.
const sessions = new Map<Electron.WebContents, number>();

async function withDebugger<T>(guest: Electron.WebContents, run: (send: (method: string, params?: object) => Promise<any>) => Promise<T>): Promise<T> {
  const count = sessions.get(guest) ?? 0;
  if (count === 0) {
    try {
      guest.debugger.attach("1.3");
    } catch (error) {
      throw new Error(`Could not inspect tab ${guest.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  sessions.set(guest, count + 1);

  try {
    return await run((method, params) => guest.debugger.sendCommand(method, params));
  } finally {
    const remaining = (sessions.get(guest) ?? 1) - 1;
    if (remaining > 0) {
      sessions.set(guest, remaining);
    } else {
      sessions.delete(guest);
      if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
    }
  }
}

function text(value: unknown, max = MAX_NAME): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

// Whether Chromium computed the name from the node's text content rather than an attribute or label.
function nameFromContents(node: AXNode): boolean {
  const source = node.name?.sources?.find(item => item.value !== undefined && !item.superseded);
  return source?.type === "contents";
}

function describe(node: AXNode, role: string, name: string): string {
  const parts = [role];
  if (name) parts.push(JSON.stringify(name));

  const focusable = node.properties?.some(property => property.name === "focusable" && property.value.value === true);
  if (node.backendDOMNodeId !== undefined && (INTERACTIVE_ROLES.has(role) || (focusable && !STRUCTURAL_ROLES.has(role)))) {
    parts.push(`[ref=e${node.backendDOMNodeId}]`);
  }

  const value = node.value?.value;
  if (value !== undefined && value !== "" && value !== name) parts.push(`value=${JSON.stringify(text(value))}`);
  for (const property of node.properties ?? []) {
    const state = property.value.value;
    if (property.name === "level" && role === "heading") parts.push(`level=${state}`);
    if (!STATES.includes(property.name) || state === false || state === "false" || state === undefined) continue;

    parts.push(state === true || state === "true" ? property.name : `${property.name}=${state}`);
  }
  return parts.join(" ");
}

// A rendered node, or a run of text. Adjacent runs of text are merged into one line, and repeated
// identical leaf nodes into one line with a count.
type Item = { line: string; children: Item[]; count: number } | { text: string };

// Renders the accessibility tree as indented lines, with a ref on each node the agent can act on.
function render(nodes: AXNode[]): { snapshot: string; truncated: boolean } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => !node.parentId) ?? nodes[0];

  // context is the name and value of the nearest rendered ancestor, passed through transparent nodes.
  // Text that repeats it is skipped.
  const build = (node: AXNode | undefined, context: string): Item[] => {
    if (!node) return [];

    const role = String(node.role?.value ?? "");
    const children = (childContext: string) => merge((node.childIds ?? []).flatMap(childId => build(byId.get(childId), childContext)));

    // List markers repeat the bullet or number of every list item.
    if (role === "ListMarker") return [];
    if (role === "StaticText") {
      const content = text(node.name?.value, MAX_TEXT);
      return content && !context.includes(content) ? [{ text: content }] : [];
    }

    const name = text(node.name?.value);
    if (node.ignored || role === "RootWebArea" || (TRANSPARENT_ROLES.has(role) && !name)) return children(context);

    // A container named after its contents, such as a table cell, would repeat what its children show.
    const shown = name && nameFromContents(node) && !INTERACTIVE_ROLES.has(role) && role !== "heading" ? "" : name;
    const own = `${shown}\n${text(node.value?.value)}`;
    const rendered = children(own.trim() ? own : "");
    // An image inside a link or button named after it, such as a logo, repeats the name.
    if ((role === "image" || role === "img") && name && context.includes(name) && rendered.length === 0) return [];
    return [{ line: describe(node, role, shown), children: rendered, count: 1 }];
  };

  const merge = (items: Item[]): Item[] => {
    const merged: Item[] = [];
    for (const item of items) {
      const last = merged[merged.length - 1];
      if ("text" in item && last && "text" in last) {
        merged[merged.length - 1] = { text: `${last.text} ${item.text}` };
      } else if ("line" in item && last && "line" in last && item.line === last.line && !item.line.includes("[ref=") &&
          item.children.length === 0 && last.children.length === 0) {
        last.count++;
      } else {
        merged.push(item);
      }
    }
    return merged;
  };

  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  const emit = (items: Item[], depth: number) => {
    for (const item of items) {
      if (truncated) return;

      const line = "text" in item ? `text: ${JSON.stringify(item.text)}` : item.count > 1 ? `${item.line} ×${item.count}` : item.line;
      const rendered = `${"  ".repeat(depth)}- ${line}`;
      if (lines.length >= MAX_LINES || chars + rendered.length > MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(rendered);
      chars += rendered.length + 1;
      if ("children" in item) emit(item.children, depth + 1);
    }
  };

  emit(build(root, ""), 0);
  return { snapshot: lines.join("\n"), truncated };
}

// Returns the accessibility snapshot of the guest's main frame. Iframes are not included.
export function snapshotTab(guest: Electron.WebContents): Promise<{ snapshot: string; truncated: boolean }> {
  return withDebugger(guest, async send => {
    const { nodes } = await send("Accessibility.getFullAXTree") as { nodes: AXNode[] };
    return render(nodes);
  });
}

// Converts a ref from snapshotTab to a CSS selector for the element as the page is now.
export function refToSelector(guest: Electron.WebContents, ref: string): Promise<string> {
  const backendNodeId = Number(ref.slice(1));
  return withDebugger(guest, async send => {
    const { frameTree } = await send("Page.getFrameTree");
    // Run in an isolated world, so page scripts cannot change how the selector is built.
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: ISOLATED_WORLD });
    let objectId: string | undefined;
    try {
      ({ object: { objectId } } = await send("DOM.resolveNode", { backendNodeId, executionContextId }));
    } catch {
      objectId = undefined;
    }
    if (!objectId) throw new PageError(`${ref} is no longer on the page. Run inspect again for current refs.`);

    const { result, exceptionDetails } = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        if (!(this instanceof Element) || !this.isConnected || this.ownerDocument !== document) return null;
        return (${pageSelector.toString()})(this);
      }`,
      returnByValue: true,
    });
    if (exceptionDetails || typeof result?.value !== "string") {
      throw new PageError(`${ref} is no longer on the page. Run inspect again for current refs.`);
    }
    return result.value;
  });
}
