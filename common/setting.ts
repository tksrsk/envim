import { z } from "zod";

const strings = z.record(z.string(), z.string());
const metadata = z.record(z.string(), z.unknown()).nullish();
const auth = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  _meta: metadata,
});
const commandPackage = z.object({ command: z.array(z.string()).default([""]), env: strings.optional(), archive: z.string().optional() });
const registryPackage = z.object({ package: z.string(), args: z.array(z.string()).optional(), env: strings.optional() });
const customAgent = z.looseObject({
  name: z.string(),
  auth: z.union([
    auth.extend({ type: z.literal("terminal"), args: z.array(z.string()).optional(), env: strings.optional() }),
    auth.extend({ type: z.string().optional() }).refine(method => method.type !== "terminal"),
  ]).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  package: commandPackage.prefault({}),
  distribution: z.object({
    npx: registryPackage.optional(),
    uvx: registryPackage.optional(),
    binary: z.record(z.string(), z.object({
      archive: z.string(), cmd: z.string(), args: z.array(z.string()).optional(), env: strings.optional(),
    })).optional(),
  }).optional(),
});

const pair = z.looseObject({ name: z.string(), value: z.string(), _meta: metadata });
const server = z.looseObject({ name: z.string(), _meta: metadata });
const remoteServer = server.extend({ url: z.string(), headers: z.array(pair).default([]) });
const mcpServer = z.union([
  remoteServer.extend({ type: z.literal("http") }),
  remoteServer.extend({ type: z.literal("sse") }),
  server.extend({ type: z.literal("acp"), serverId: z.string() }),
  server.extend({ type: z.literal("stdio").optional(), command: z.string(), args: z.array(z.string()).default([]), env: z.array(pair).default([]) }),
]);

const defaultOptions: Record<string, boolean> = {
  ext_multigrid: true,
  ext_cmdline: true,
  ext_tabline: true,
  ext_popupmenu: true,
  ext_messages: true,
  ext_hlstate: true,
  ext_termcolors: true,
};

export const settingSchema = z.object({
  type: z.enum(["command", "address", "docker", "ssh"]).default("command"),
  path: z.string().default(""),
  font: z.object({
    size: z.number().positive().default(16),
    width: z.number().positive().default(8),
    height: z.number().positive().default(17),
    lspace: z.number().default(2),
    scale: z.number().positive().default(1),
  }).prefault({}),
  opacity: z.number().min(0).max(100).default(0),
  options: z.record(z.string(), z.boolean()).prefault({}).transform((options): Record<string, boolean> => ({ ...defaultOptions, ...options })),
  bookmarks: z.array(z.object({ name: z.string(), path: z.string(), selected: z.boolean().default(false) })).default([]),
  searchengines: z.array(z.object({ name: z.string(), uri: z.string(), selected: z.boolean().default(false) })).default([
    { name: "Google", uri: "https://google.com/search?q=${query}", selected: true },
  ]),
  acp: z.object({
    customs: z.array(customAgent).default([]),
    mcpServers: z.array(z.object({ enabled: z.boolean().default(true), server: mcpServer })).default([]),
  }).prefault({}),
  get presets(): z.ZodDefault<z.ZodRecord<z.ZodString, typeof settingSchema>> {
    return z.record(z.string(), settingSchema).default({});
  },
});

export type ISetting = z.infer<typeof settingSchema>;
