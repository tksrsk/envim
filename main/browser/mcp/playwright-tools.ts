import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createConnection } from "@playwright/mcp";
import type { BrowserContext } from "playwright-core";

export const playwrightToolNames = new Set([
  "browser_snapshot", "browser_find", "browser_evaluate", "browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_wait_for", "browser_take_screenshot",
  "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_handle_dialog", "browser_emulate_media",
  "browser_tabs", "browser_navigate", "browser_navigate_back",
  "browser_route", "browser_route_list", "browser_unroute", "browser_network_state_set",
  "browser_verify_element_visible", "browser_verify_text_visible", "browser_verify_list_visible",
  "browser_verify_value", "browser_generate_locator",
  "browser_start_tracing", "browser_stop_tracing",
  "browser_highlight", "browser_hide_highlight",
  "browser_file_upload", "browser_drop",
  "browser_start_recording", "browser_stop_recording", "browser_start_video", "browser_stop_video",
  "browser_press_key", "browser_hover", "browser_drag",
  "browser_mouse_move_xy", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel",
]);

const outputDirs = new WeakMap<Client, string>();
const maxUploadBytes = 10 * 1024 * 1024;

export function isFileTool(name: string): boolean {
  return name === "browser_file_upload" || name === "browser_drop";
}

export async function callFileTool(client: Client, name: string, args: Record<string, unknown>, signal: AbortSignal) {
  const { files, ...remaining } = args;
  if (Object.hasOwn(remaining, "paths")) throw new Error("Send file contents in files.");
  if (files === undefined) return client.callTool({ name, arguments: remaining }, { signal });
  if (!Array.isArray(files) || files.length === 0 || files.length > 16) throw new Error("Send between 1 and 16 files.");
  const directory = await mkdtemp(join(outputDirs.get(client)!, "upload-"));
  try {
    let total = 0;
    const paths: string[] = [];
    for (const file of files) {
      const { name: filename, base64 } = file ?? {};
      if (typeof filename !== "string" || filename.length > 200 || !filename ||
        /[/\\<>:"|?*]|\p{Cc}|[. ]$|^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/iu.test(filename)) {
        throw new Error("Each file needs a valid filename.");
      }
      if (typeof base64 !== "string" || base64.length > Math.ceil((maxUploadBytes - total) / 3) * 4 ||
        base64.length % 4 !== 0) {
        throw new Error("Send valid Base64 with at most 10 MiB of decoded data in total.");
      }
      const bytes = Buffer.from(base64, "base64");
      total += bytes.length;
      if (total > maxUploadBytes || bytes.toString("base64") !== base64) {
        throw new Error("Send valid Base64 with at most 10 MiB of decoded data in total.");
      }
      const subdir = join(directory, String(paths.length));
      await mkdir(subdir);
      const path = join(subdir, filename);
      await writeFile(path, bytes, { flag: "wx", signal });
      paths.push(path);
    }
    return await client.callTool({ name, arguments: { ...remaining, paths } }, { signal });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function videoDirectory(client: Client): Promise<string> {
  return mkdtemp(join(outputDirs.get(client)!, "recording-"));
}

export async function videoFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(".webm")).map(entry => join(directory, entry.name));
}

export async function connectPlaywrightTools(context: () => Promise<BrowserContext>, signal?: AbortSignal): Promise<Client> {
  const client = new Client({ name: "envim-playwright", version: "1.0.0" });
  signal?.throwIfAborted();
  const outputDir = await mkdtemp(join(tmpdir(), "envim-playwright-"));
  outputDirs.set(client, outputDir);
  const cleanup = () => rm(outputDir, { recursive: true, force: true }).catch(() => {});
  client.onclose = () => void cleanup();
  let server: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    server = await createConnection({
      webmcp: false,
      capabilities: ["network", "testing", "devtools", "vision"],
      snapshot: { mode: "none" },
      timeouts: { navigation: 10000 },
      outputDir,
    }, context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    signal?.throwIfAborted();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    signal?.throwIfAborted();
    return client;
  } catch (error) {
    try {
      await server?.close();
    } finally {
      await cleanup();
    }
    throw error;
  }
}

let tools: ReturnType<typeof listTools> | undefined;

export function listPlaywrightTools() {
  return tools ??= listTools().catch(error => {
    tools = undefined;
    throw error;
  });
}

async function listTools() {
  const client = await connectPlaywrightTools(async () => { throw new Error("A shared tab is required."); });
  try {
    return (await client.listTools()).tools.filter(tool => playwrightToolNames.has(tool.name)).map(tool => {
      const { filename: _filename, ...properties } = tool.inputSchema.properties ?? {};
      if (isFileTool(tool.name)) {
        const { paths: _paths, ...fileProperties } = properties;
        return {
          ...tool,
          description: tool.name === "browser_file_upload"
            ? "Upload files to the open file chooser. Omit files to cancel it."
            : "Drop files and/or MIME-typed data onto an element in the selected shared tab.",
          inputSchema: { ...tool.inputSchema, properties: { ...fileProperties, files: {
            type: "array", minItems: 1, maxItems: 16,
            description: "File names and Base64 contents, up to 10 MiB decoded in total.",
            items: { type: "object", required: ["name", "base64"], properties: {
              name: { type: "string" }, base64: { type: "string" },
            } },
          } } },
        };
      }
      if (tool.name === "browser_tabs") {
        const { isolatedContext: _isolated, ...tabProperties } = properties;
        return {
          ...tool,
          description: "List, create, or select shared tabs in the current Envim workspace. The list includes Envim tab IDs.",
          inputSchema: {
            ...tool.inputSchema,
            properties: { ...tabProperties, action: { type: "string", enum: ["list", "new", "select"] } },
          },
        };
      }
      return {
        ...tool,
        ...(tool.name === "browser_start_video" ? { description: "Start video recording across this session's shared tabs." } : {}),
        ...(tool.name === "browser_stop_video" ? { description: "Stop video recording and return file IDs for the downloads tool." } : {}),
        inputSchema: { ...tool.inputSchema, properties },
      };
    });
  } finally {
    await client.close();
  }
}
