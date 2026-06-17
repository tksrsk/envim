import { randomBytes } from "crypto";
import * as AcpSDK from "@agentclientprotocol/sdk";

import { IAcpRegistry, IAcpRegistryAgent, IPermissionRequest, IAcpStatus, IAcpSession } from "common/interface";

import { Emit } from "main/emit";
import { Mcp } from "main/mcp";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export class Acp {
  private static initialized = false;
  private static state: IAcpStatus = { status: "disconnected" };
  private static workspace: { current: { name: string; cwd: string }; state: { [k: string]: { cwd: string; status: IAcpStatus } }; } = { current: { name: "default", cwd: "" }, state: {} };
  private static connection: AcpSDK.ClientSideConnection | null = null;
  private static capabilities?: AcpSDK.AgentCapabilities;
  private static sessions: { [key: string]: IAcpSession } = {};
  private static tool: { [key: string]: AcpSDK.ToolCallUpdate } = {};
  private static terminal: { [key: string]: { promise: Promise<AcpSDK.WaitForTerminalExitResponse>, output: string, truncated: boolean, pid: number, resolve?: (response: AcpSDK.WaitForTerminalExitResponse) => void } } = {};
  private static permission: { [key: string]: (response: AcpSDK.RequestPermissionResponse) => void } = {};
  private static registry: IAcpRegistry = { npx: { available: false, agent: [] }, uvx: { available: false, agent: [] } };
  private static registryLoaded = false;

  static async setup(init: boolean, workspace: string) {
    if (!Acp.initialized) {
      Acp.initialized = true;
      Emit.on("acp:toggle", Acp.togglePanel);
      Emit.on("acp:start-agent", Acp.startAgent);
      Emit.on("acp:stop-agent", Acp.stopAgent);
      Emit.on("acp:create-session", Acp.createSession);
      Emit.on("acp:switch-session", Acp.setActiveSession);
      Emit.on("acp:delete-session", Acp.deleteSession);
      Emit.on("acp:send-prompt", Acp.sendPrompt);
      Emit.on("acp:cancel-prompt", Acp.cancelPrompt);
      Emit.on("acp:permission-response", Acp.handlePermissionResponse);
      Emit.on("acp:config-session", Acp.onSetSessionConfigOption);
      Emit.on("acp:terminal-output", Acp.onTerminalOutput);
      Emit.on("acp:terminal-exit", Acp.onTerminalExit);
      Emit.on("envim:cwd", Acp.setCwd);
    }

    Acp.workspace.state[Acp.workspace.current.name] = { cwd: Acp.workspace.current.cwd, status: Acp.state };
    Acp.workspace.current = { name: workspace, cwd: Acp.workspace.state[workspace]?.cwd || "" };
    Acp.sessions = !init ? Acp.sessions : Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== workspace));

    Object.values(Acp.sessions).forEach(s => s.status = s.workspace === Acp.workspace.current.name ? "show" : "hide");

    Acp.setState((!init && Acp.workspace.state[workspace]?.status) || { status: "disconnected" });
    Acp.notifySessionUpdate();
    Emit.share("envim:luafile", "acp.lua");
  }

  private static setCwd(cwd: string): void {
    if (cwd) {
      Acp.workspace.current.cwd = cwd;
      Acp.workspace.state[Acp.workspace.current.name] = { cwd, status: Acp.state };
    }
  }

  private static onSetSessionConfigOption(configId: string, value: string | boolean) {
    if (!Acp.connection || !Acp.state.sessionId) {
      return;
    }

    const sessionId = Acp.state.sessionId;
    const params = typeof value === "boolean"
      ? { sessionId, configId, type: "boolean" as const, value }
      : { sessionId, configId, value };

    Acp.callAgent(Acp.connection.setSessionConfigOption(params)).then(response => {
      if (!response) return;

      const session = Acp.sessions[sessionId];
      if (session) {
        session.configOptions = response.configOptions;
        Acp.notifySessionUpdate();
      }
    });
  }

  private static onTerminalOutput(data: { terminalId: string; output: string }) {
    const terminal = Acp.terminal[data.terminalId];

    if (terminal) {
      terminal.output = [terminal.output, data.output].filter(output => output).join("\n");
    }
  }

  private static onTerminalExit(data: { terminalId: string; exitCode: number; signal: string }) {
    const terminal = Acp.terminal[data.terminalId];

    if (terminal?.resolve) {
      terminal.pid = 0;
      terminal.resolve(data);
    }
  }

  private static setState(state: IAcpStatus) {
    Acp.state = state;

    Emit.update("acp:status-changed", false, Acp.state);
  }

  private static async loadRegistry() {
    if (!Acp.registryLoaded) {
      const response = await fetch(ACP_REGISTRY_URL);

      if (response.ok) {
        const agents = ((await response.json() as { agents: IAcpRegistryAgent[] }).agents)
          .filter(agent => !!(agent.name && agent.distribution && (agent.distribution.npx || agent.distribution.uvx)))
          .sort((a, b) => a.name.localeCompare(b.name));

        Acp.registry = {
          npx: {
            available: await Emit.share("envim:api", "nvim_call_function", ["executable", ["npx"]]) === 1,
            agent: agents.flatMap(agent => agent.distribution?.npx ? [{
              ...agent,
              package: {
                command: ["npx", "--yes", agent.distribution.npx.package, ...(agent.distribution.npx.args || [])],
                ...(agent.distribution.npx.env ? { env: agent.distribution.npx.env } : {})
              }
            }] : [])
          },
          uvx: {
            available: await Emit.share("envim:api", "nvim_call_function", ["executable", ["uvx"]]) === 1,
            agent: agents.flatMap(agent => agent.distribution?.uvx ? [{
              ...agent,
              package: {
                command: ["uvx", agent.distribution.uvx.package, ...(agent.distribution.uvx.args || [])],
                ...(agent.distribution.uvx.env ? { env: agent.distribution.uvx.env } : {})
              }
            }] : [])
          }
        };
        Acp.registryLoaded = true;
      }
    }

    return Acp.registry;
  }

  private static async togglePanel(): Promise<void> {
    Emit.send("acp:toggle", await Acp.loadRegistry());
  }

  private static handleSessionUpdate(params: AcpSDK.SessionNotification): void {
    if (!params.sessionId || params.sessionId !== Acp.state.sessionId) return;

    if (
      !Acp.handleToolCallUpdate(params) &&
      !Acp.handlePlanUpdate(params) &&
      !Acp.handleAvailableCommandsUpdate(params) &&
      !Acp.handleConfigOptionUpdate(params) &&
      !Acp.handleSessionInfoUpdate(params) &&
      !Acp.handleUsageUpdate(params)
    ) {
      Acp.addMessage(params);
    }

    Acp.notifySessionUpdate();
  }

  private static processToolUpdate(sessionId: string, toolCall: AcpSDK.ToolCallUpdate) {
    toolCall._meta = toolCall._meta || {};

    Object.keys(Acp.tool[toolCall.toolCallId] || {}).forEach(k => toolCall[k] = toolCall[k] || Acp.tool[toolCall.toolCallId][k]);
    Object.keys((Acp.tool[toolCall.toolCallId]?._meta) || {}).forEach(k => toolCall._meta![k] = toolCall._meta![k] || Acp.tool[toolCall.toolCallId]._meta![k]);

    if (!toolCall._meta.start && toolCall.status !== "pending") {
      toolCall._meta.start = Date.now();
    }
    if (toolCall.status !== "pending" && toolCall._meta.start) {
      toolCall._meta.executionTime = ((Date.now() - (toolCall._meta.start as number)) / 1000).toFixed(1);
    }

    Acp.tool[toolCall.toolCallId] = toolCall;

    Acp.addMessage({
      sessionId,
      update: { sessionUpdate: "tool_call_update", ...toolCall }
    });

    if (toolCall.status === "completed" || toolCall.status === "failed") {
      delete(Acp.tool[toolCall.toolCallId]);
    }
  }

  private static handleToolCallUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return false;
    }

    Acp.processToolUpdate(params.sessionId, params.update);

    return true;
  }

  private static callAgent<T>(promise: Promise<T>): Promise<T | void> {
    Acp.setState({ ...Acp.state, error: undefined });

    return promise.catch(err => {
      Acp.setState({ ...Acp.state, status: "connected", error: err instanceof Error ? err.message : String(err) });
    });
  }

  static async startAgent(agent: IAcpRegistryAgent) {
    Acp.setState({ status: "connecting" });

    const result = await Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStart", [agent.package]]);

    if (result == "executed") {
      if (!Acp.connection) {
        Acp.connection = new AcpSDK.ClientSideConnection(
          () => Acp.createClient(),
          Acp.createStream()
        );
      }

      Acp.callAgent(Acp.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        },
        clientInfo: {
          name: "Envim",
          title: "Envim Editor",
          version: "1.0.0"
        }
      })).then(response => {
        if (!response) return;

        Acp.capabilities = response.agentCapabilities;
        Acp.setState({ ...Acp.state, status: "connected" });
        Acp.listSession();
      });
    } else {
      Acp.setState({ status: result === "initialized" ? "connected" : "disconnected" });
    }
  }

  static listSession() {
    if (!Acp.connection) {
      return;
    }

    if (Acp.capabilities?.sessionCapabilities?.list) {
      Acp.setState({ ...Acp.state, status: "processing" });
      Acp.callAgent(Acp.connection.listSessions({ cwd: Acp.workspace.current.cwd })).then(response => {
        if (!response) return;

        response.sessions.forEach(session => {
          if (!Acp.sessions[session.sessionId]) {
            Acp.sessions[session.sessionId] = {
              id: session.sessionId,
              name: session.title || session.updatedAt || session.sessionId,
              workspace: Acp.workspace.current.name,
              loaded: false,
              status: "show",
              commands: [],
              configOptions: [],
              plan: [],
            };
          }
        });

        Acp.notifySessionUpdate();
        Acp.setState({ ...Acp.state, status: "connected" });
      });
    }
  }

  static async createSession() {
    if (!Acp.connection) {
      return;
    }

    Acp.setState({ ...Acp.state, status: "processing" });

    if (Acp.state.sessionId && Acp.capabilities?.sessionCapabilities?.close) {
      await Acp.connection.closeSession({ sessionId: Acp.state.sessionId });
    }

    return Acp.callAgent(Acp.connection.newSession({
      cwd: Acp.workspace.current.cwd,
      mcpServers: await Mcp.servers(),
    })).then(response => {
      if (!response) return;

      const session: IAcpSession = {
        id: response.sessionId,
        name: `Session ${new Date().toLocaleTimeString()}`,
        workspace: Acp.workspace.current.name,
        loaded: true,
        status: "show",
        configOptions: response.configOptions || [],
        commands: [],
        plan: [],
      };

      Acp.sessions[session.id] = session;
      Acp.setState({ ...Acp.state, status: "connected", sessionId: session.id });
      Acp.notifySessionUpdate();
    });
  }

  static stopAgent() {
    Acp.setState({ status: "disconnected" });

    Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStop", []]);
  }


  static cleanup() {
    Acp.tool = {};
    Acp.permission = {};
    Acp.sessions = Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== Acp.workspace.current.name));

    Acp.setState({ status: "disconnected" });
    Acp.notifySessionUpdate();
  }

  static deleteSession(sessionId: string) {
    if (Acp.connection && Acp.capabilities?.sessionCapabilities?.delete) {
      Acp.callAgent(Acp.connection.deleteSession({ sessionId }));
    }

    delete(Acp.sessions[sessionId]);

    if (Acp.state.sessionId === sessionId) {
      delete(Acp.state.sessionId);
    }

    Acp.setState({ status: "connected" });
    Acp.notifySessionUpdate();
  }

  static async setActiveSession(sessionId: string) {
    const session = Acp.sessions[sessionId];

    if (!session || !Acp.connection) {
      return;
    }

    if (Acp.state.sessionId && Acp.capabilities?.sessionCapabilities?.close) {
      await Acp.connection.closeSession({ sessionId: Acp.state.sessionId });
    }

    if (
      (session.loaded && Acp.capabilities?.sessionCapabilities?.resume) ||
      (!session.loaded && Acp.capabilities?.loadSession)
    ) {
      const mcpServers = await Mcp.servers();
      const method = session.loaded ? "resumeSession" : "loadSession";

      Acp.setState({ ...Acp.state, status: "processing", sessionId });
      Acp.callAgent(Acp.connection[method]({
        sessionId, cwd: Acp.workspace.current.cwd, mcpServers
      })).then(response => {
        if (!response) return;

        session.configOptions = response.configOptions || [];
        Acp.setState({ ...Acp.state, status: "connected" });
        Acp.notifySessionUpdate();
      });

      session.loaded = true;
    } else {
      Acp.setState({ ...Acp.state, sessionId });
      Acp.notifySessionUpdate();
    }
  }

  static addMessage(notification: AcpSDK.SessionNotification) {
    Emit.send("acp:message-added", notification);
  }

  static sendPrompt(sessionId: string, text: string, files: string[] = [], images: AcpSDK.ImageContent[] = []) {
    const callback = (sessionId: string) => {
      if (!Acp.connection || !Acp.sessions[sessionId]) {
        return;
      }

      const prompt: AcpSDK.ContentBlock[] = [
        ...(text ? [{ type: "text" as "text", text }] : []),
        ...files.map(file => ({ type: "resource_link" as "resource_link", uri: `file://${file}`, name: file.split("/").pop() || file })),
        ...(Acp.capabilities?.promptCapabilities?.image ? images.map(image => ({ ...image, type: "image" as "image" })) : [] ),
      ];

      prompt.forEach(content => Acp.addMessage({ sessionId, update: { sessionUpdate: "user_message_chunk", content }}));
      Acp.setState({ ...Acp.state, status: "processing" });
      Acp.callAgent(Acp.connection.prompt({ sessionId, prompt })).then(result => {
        if (!result) return;

        if (result && result.stopReason !== "end_turn") {
          Acp.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.stopReason } } });
        }
        Acp.tool = {};
        Acp.permission = {};
        Acp.setState({ ...Acp.state, status: "connected" });
      });
    }

    if (!sessionId) {
      Acp.createSession()?.then(() => {
        callback(Acp.state.sessionId!);
      });
    } else {
      callback(sessionId);
    }

  }

  static cancelPrompt(sessionId: string) {
    if (!Acp.connection) {
      return;
    }

    Acp.setState({ ...Acp.state, status: "processing" });
    Acp.callAgent(Acp.connection.cancel({ sessionId }));
    Acp.setState({ ...Acp.state, status: "connected" });
  }


  private static notifySessionUpdate(): void {
    Emit.update("acp:session-update", false, Acp.state.sessionId, Object.values(Acp.sessions));
  }

  private static handlePlanUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "plan") {
      return false;
    }

    const session = Acp.sessions[params.sessionId];

    if (session) {
      session.plan = params.update.entries;
      Acp.notifySessionUpdate();
    }

    return true;
  }

  private static handleAvailableCommandsUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "available_commands_update") {
      return false;
    }

    const session = Acp.sessions[params.sessionId];

    if (session) {
      session.commands = params.update.availableCommands;
      Acp.notifySessionUpdate();
    }

    return true;
  }

  private static handleConfigOptionUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "config_option_update") {
      return false;
    }

    const session = Acp.sessions[params.sessionId];

    if (session) {
      session.configOptions = params.update.configOptions;
      Acp.notifySessionUpdate();
    }

    return true;
  }

  private static handleSessionInfoUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "session_info_update") {
      return false;
    }

    const session = Acp.sessions[params.sessionId];

    if (session && params.update.title) {
      session.name = params.update.title;
      Acp.notifySessionUpdate();
    }

    return true;
  }

  private static handleUsageUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "usage_update") {
      return false;
    }

    const session = Acp.sessions[params.sessionId];

    if (session) {
      session.usage = params.update;
      Acp.notifySessionUpdate();
    }

    return true;
  }

  private static async handleReadTextFile(params: AcpSDK.ReadTextFileRequest): Promise<AcpSDK.ReadTextFileResponse> {
    const lines = await Emit.share("envim:api", "nvim_call_function", ["readfile", [params.path]]);

    return { content: Array.isArray(lines) ? lines.join("\n") : "" };
  }

  private static async handleWriteTextFile(params: AcpSDK.WriteTextFileRequest): Promise<AcpSDK.WriteTextFileResponse> {
    await Emit.share("envim:api", "nvim_call_function", ["writefile", [params.content.split("\n"), params.path]]);

    return {};
  }

  private static async handleCreateTerminal(params: AcpSDK.CreateTerminalRequest): Promise<AcpSDK.CreateTerminalResponse> {
    const terminalId = `term__${Date.now()}`;
    const command = [params.command, ...(params.args || [])];
    const env = params.env?.reduce((envs, v) => ({ ...envs, [v.name]: v.value }), {} as Record<string, string>);
    const opts = { cwd: params.cwd || undefined, env };

    const pid = await Emit.share("envim:api", "nvim_call_function", ["EnvimAcpTerminalStart", [terminalId, command, opts]]) as number | null;

    if (pid) {
      Acp.terminal[terminalId] = {
        promise: new Promise<AcpSDK.WaitForTerminalExitResponse>((resolve) => Acp.terminal[terminalId].resolve = resolve),
        output: "",
        truncated: false,
        pid,
      };
    }

    return { terminalId };
  }

  private static async handleTerminalOutput(params: AcpSDK.TerminalOutputRequest): Promise<AcpSDK.TerminalOutputResponse> {
    const terminal = Acp.terminal[params.terminalId]!;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.pid ? undefined : { exitCode: 0 },
    };
  }

  private static async handleWaitForTerminalExit(params: AcpSDK.WaitForTerminalExitRequest): Promise<AcpSDK.WaitForTerminalExitResponse> {
    return Acp.terminal[params.terminalId].promise;
  }

  private static async handleKillTerminal(params: AcpSDK.KillTerminalRequest): Promise<AcpSDK.KillTerminalResponse> {
    const { pid } = Acp.terminal[params.terminalId];

    Emit.share("envim:api", "nvim_call_function", ["jobstop", [pid]]);

    return {};
  }

  private static async handleReleaseTerminal(params: AcpSDK.ReleaseTerminalRequest): Promise<AcpSDK.ReleaseTerminalResponse> {
    const { pid } = Acp.terminal[params.terminalId];

    await Emit.share("envim:api", "nvim_call_function", ["jobstop", [pid]]);
    delete(Acp.terminal[params.terminalId]);

    return {};
  }

  private static createStream() {
    const { Readable, Writable } = require("stream");

    const nodeReadable = new Readable({ read() {} });
    const nodeWritable = new Writable({
      write: (chunk: any, _encoding: any, callback: any) => {
        Emit.share("envim:api", "nvim_call_function", ["EnvimAcpSend", [chunk.toString()]]);
        callback();
      }
    });

    const webReadable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        nodeReadable.on("data", (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
        nodeReadable.on("end", () => controller.close());
        nodeReadable.on("error", (err: unknown) => controller.error(err));
      }
    });

    const webWritable = new WritableStream<Uint8Array>({
      write: (chunk) => new Promise((resolve, reject) => {
        nodeWritable.write(chunk, "utf8", (err: unknown) => err ? reject(err) : resolve());
      })
    });

    const onAgentResponse = (data: string) => {
      nodeReadable.push(`${data}\n`);
    };

    Emit.on("acp:stdout", onAgentResponse);
    Emit.on("acp:exited", Acp.cleanup);

    return AcpSDK.ndJsonStream(webWritable, webReadable);
  }

  private static async handleRequestPermission(params: AcpSDK.RequestPermissionRequest): Promise<AcpSDK.RequestPermissionResponse> {
    const requestId = `perm_${randomBytes(16).toString("hex")}`;

    params.toolCall._meta = params.toolCall._meta || {};
    params.toolCall._meta.permissionRequest = { requestId, options: params.options };
    Acp.processToolUpdate(Acp.state.sessionId!, params.toolCall);

    return new Promise((resolve) => Acp.permission[requestId] = resolve);
  }

  static handlePermissionResponse(requestId: string, optionId: string): void {
    const resolver = Acp.permission[requestId];

    if (!resolver) {
      return;
    }

    resolver({ outcome: { outcome: "selected", optionId } });
    delete(Acp.permission[requestId]);

    const tool = Object.values(Acp.tool).find(t => {
      const permissionRequest = t._meta?.permissionRequest as IPermissionRequest | undefined;
      return permissionRequest?.requestId === requestId;
    });

    if (tool) {
      delete(Acp.tool[tool.toolCallId]._meta!.permissionRequest);
      Acp.processToolUpdate(Acp.state.sessionId!, tool);
    }
  }

  private static createClient(): AcpSDK.Client {
    return {
      readTextFile: async params => await Acp.handleReadTextFile(params),
      writeTextFile: async params => await Acp.handleWriteTextFile(params),
      createTerminal: async params => Acp.handleCreateTerminal(params),
      terminalOutput: async params => Acp.handleTerminalOutput(params),
      waitForTerminalExit: async params => Acp.handleWaitForTerminalExit(params),
      killTerminal: async params => Acp.handleKillTerminal(params),
      releaseTerminal: async params => Acp.handleReleaseTerminal(params),
      requestPermission: async params => Acp.handleRequestPermission(params),
      sessionUpdate: async params => Acp.handleSessionUpdate(params)
    };
  }
}
