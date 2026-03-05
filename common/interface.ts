import {
  McpServer,
  SessionModeState,
  SessionModelState,
  PermissionOption,
  AvailableCommand,
  PlanEntry,
  UsageUpdate
} from "@agentclientprotocol/sdk";

export interface ISetting {
  type: "command" | "address" | "docker" | "ssh";
  path: string;
  font: { size: number; width: number; height: number; lspace: number; scale: number; };
  opacity: number;
  options: { [k: string]: boolean; };
  bookmarks: { name: string, path: string; selected: boolean; }[];
  searchengines: { name: string, uri: string; selected: boolean; }[];
  acp: { command: string; mcpServers: { enabled: boolean; server: McpServer }[]; };
  presets: { [k: string]: ISetting };
}

export interface IWindow {
  id: string;
  gid: number;
  winid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  focusable: boolean;
  focus: boolean;
  shadow: boolean;
  type: "normal" | "floating" | "external";
  status: "show" | "hide" | "delete";
}

export interface ICell {
  row: number;
  col: number;
  text: string;
  hl: string;
  width: number;
}

export interface IScroll {
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number;
  cols: number;
}

export interface IHighlight {
  foreground?: number;
  background?: number;
  special?: number;
  reverse?: boolean;
  italic?: boolean;
  bold?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  underdouble?: boolean;
  undercurl?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
  altfont?: boolean;
  blend?: number;
  url?: string;
}

export interface ITab {
  name: string;
  buffer: number;
  active: boolean;
}

export interface IBuffer {
  name: string;
  buffer: number;
  active: boolean;
}

export interface IMessage {
  kind: string;
  contents: { hl: string, content: string }[];
}

export interface IMode {
  cursor_shape: "block" | "horizontal" | "vertical";
  cell_percentage: number;
  attr_id: string;
  name: string;
  short_name: string;
}

export interface IMenu {
  name: string;
  active: boolean;
  hidden: boolean;
  mappings: { [k: string]: { enabled: boolean; rhs: string; } };
  submenus?: IMenu[];
}


export interface IPermissionRequest {
  requestId: string;
  options: PermissionOption[];
  selectedOptionId?: string;
}

export interface IAcpSession {
  id: string;
  name: string;
  workspace: string;
  status: "show" | "hide";
  commands: AvailableCommand[];
  modes?: SessionModeState | null;
  models?: SessionModelState | null;
  usage?: UsageUpdate;
}

export interface IAcpStatus {
  status: "disconnected" | "connecting" | "connected" | "processing";
  sessionId?: string;
  plan: PlanEntry[];
}
