import type * as Electron from "electron";

import { PageError } from "main/mcp/inject";
import { pageSelector } from "main/mcp/page";

const MAX_LINES = 500;
const MAX_CHARS = 30000;
const MAX_NAME = 200;
const ISOLATED_WORLD = "envim-browser-tools";

// Roles that get a ref, so the agent can act on them. Focusable nodes get one as well.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "disclosuretriangle",
]);
// Roles that only group their children. They are skipped when they have no name.
const TRANSPARENT_ROLES = new Set([
  "none", "generic", "presentation", "InlineTextBox", "LineBreak", "LayoutTableCell", "LayoutTableRow", "LabelText", "MenuListPopup",
]);
const STATES = ["checked", "pressed", "selected", "expanded", "disabled", "required", "readonly", "invalid", "focused"];

interface AXValue {
  value?: unknown;
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

function describe(node: AXNode, role: string, name: string): string {
  const parts = [role];
  if (name) parts.push(JSON.stringify(name));

  const focusable = node.properties?.some(property => property.name === "focusable" && property.value.value === true);
  if (node.backendDOMNodeId !== undefined && (INTERACTIVE_ROLES.has(role) || focusable)) parts.push(`[ref=e${node.backendDOMNodeId}]`);

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

// Renders the accessibility tree as indented lines, with a ref on each node the agent can act on.
function render(nodes: AXNode[]): { snapshot: string; truncated: boolean } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => !node.parentId) ?? nodes[0];
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;

  // context is the name and value of the nearest rendered ancestor, passed through transparent nodes.
  // Text that repeats it is skipped.
  const visit = (node: AXNode | undefined, depth: number, context: string) => {
    if (!node || truncated) return;

    const role = String(node.role?.value ?? "");
    const name = text(node.name?.value);
    const children = () => {
      const own = `${name}\n${text(node.value?.value)}`;
      for (const childId of node.childIds ?? []) visit(byId.get(childId), depth + 1, own.trim() ? own : "");
    };
    const passThrough = () => {
      for (const childId of node.childIds ?? []) visit(byId.get(childId), depth, context);
    };

    // List markers repeat the bullet or number of every list item.
    if (role === "ListMarker") return;
    if (node.ignored || role === "RootWebArea" || (TRANSPARENT_ROLES.has(role) && !name)) return passThrough();

    let line: string;
    if (role === "StaticText") {
      if (!name || context.includes(name)) return;
      line = `text: ${JSON.stringify(name)}`;
    } else {
      line = describe(node, role, name);
    }

    const rendered = `${"  ".repeat(depth)}- ${line}`;
    if (lines.length >= MAX_LINES || chars + rendered.length > MAX_CHARS) {
      truncated = true;
      return;
    }
    lines.push(rendered);
    chars += rendered.length + 1;
    if (role !== "StaticText") children();
  };

  visit(root, 0, "");
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
