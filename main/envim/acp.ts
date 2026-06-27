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
  private static connection: AcpSDK.ClientConnection | null = null;
  private static sessions: { [key: string]: IAcpSession } = {};
  private static tool: { [key: string]: AcpSDK.ToolCallUpdate } = {};
  private static terminal: { [key: string]: { promise: Promise<AcpSDK.WaitForTerminalExitResponse>, output: string, truncated: boolean, pid: number, resolve?: (response: AcpSDK.WaitForTerminalExitResponse) => void } } = {};
  private static permission: { [key: string]: (response: AcpSDK.RequestPermissionResponse) => void } = {};
  private static lastMessageId: { [k: string]: string } = {};
  private static registry: IAcpRegistry = { npx: { available: false, agent: [] }, uvx: { available: false, agent: [] } };
  private static registryLoaded = false;

  static async setup(init: boolean, workspace: string) {
    if (!Acp.initialized) {
      Acp.initialized = true;
      Emit.on("acp:toggle", Acp.onToggle);
      Emit.on("acp:start-agent", Acp.onStartAgent);
      Emit.on("acp:stop-agent", Acp.onStopAgent);
      Emit.on("acp:create-session", Acp.onCreateSession);
      Emit.on("acp:switch-session", Acp.onSwitchSession);
      Emit.on("acp:delete-session", Acp.onDeleteSession);
      Emit.on("acp:send-prompt", Acp.onSendPrompt);
      Emit.on("acp:cancel-prompt", Acp.onCancelPrompt);
      Emit.on("acp:permission-response", Acp.onPermissionResponse);
      Emit.on("acp:authenticate", Acp.onAuthenticate);
      Emit.on("acp:logout", Acp.onLogout);
      Emit.on("acp:config-session", Acp.onSetSessionConfigOption);
      Emit.on("acp:terminal-output", Acp.onTerminalOutput);
      Emit.on("acp:terminal-exit", Acp.onTerminalExit);
      Emit.on("envim:cwd", Acp.onCwd);
    }

    Acp.workspace.state[Acp.workspace.current.name] = { cwd: Acp.workspace.current.cwd, status: Acp.state };
    Acp.workspace.current = { name: workspace, cwd: Acp.workspace.state[workspace]?.cwd || "" };
    Acp.sessions = !init ? Acp.sessions : Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== workspace));

    Object.values(Acp.sessions).forEach(s => s.status = s.workspace === Acp.workspace.current.name ? "show" : "hide");

    Acp.setState((!init && Acp.workspace.state[workspace]?.status) || { status: "disconnected" });
    Acp.notifySessionUpdate();
    Emit.share("envim:luafile", "acp.lua");
  }

  private static onCwd(cwd: string): void {
    if (cwd) {
      Acp.workspace.current.cwd = cwd;
      Acp.workspace.state[Acp.workspace.current.name] = { cwd, status: Acp.state };
    }
  }

  private static onSetSessionConfigOption(configId: string, value: string | boolean) {
    if (!Acp.connection || !Acp.state.sessionId) return;

    const sessionId = Acp.state.sessionId;
    const params = typeof value === "boolean"
      ? { sessionId, configId, type: "boolean" as const, value }
      : { sessionId, configId, value };

    Acp.callAgent(AcpSDK.methods.agent.session.setConfigOption, params).then(response => {
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

  private static async onToggle(): Promise<void> {
    Emit.send("acp:toggle", await Acp.loadRegistry());
  }

  private static onSessionUpdate(params: AcpSDK.SessionNotification): void {
    if (!params.sessionId || params.sessionId !== Acp.state.sessionId) return;

    if (
      !Acp.onToolCallUpdate(params) &&
      !Acp.onPlanUpdate(params) &&
      !Acp.onAvailableCommandsUpdate(params) &&
      !Acp.onConfigOptionUpdate(params) &&
      !Acp.onSessionInfoUpdate(params) &&
      !Acp.onUsageUpdate(params)
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

  private static onToolCallUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return false;
    }

    Acp.processToolUpdate(params.sessionId, params.update);

    return true;
  }

  private static callAgent<M extends AcpSDK.AgentRequestMethod>(
    method: M,
    params: AcpSDK.AgentRequestParamsByMethod[M],
  ): Promise<AcpSDK.AgentRequestResponsesByMethod[M] | void> {
    if (!Acp.connection) return Promise.resolve();

    Acp.setState({ ...Acp.state, error: undefined });

    return (Acp.connection.agent.request(method, params)).catch(err => {
      const error = err instanceof Error ? err.message : String(err);
      const autherror = Acp.state.initialize?.authMethods?.length && err instanceof AcpSDK.RequestError && err.code === -32000;
      const status = autherror ? "auth_required" : "connected";

      Acp.setState({ ...Acp.state, status, error });
    });
  }

  static async onStartAgent(agent: IAcpRegistryAgent) {
    Acp.setState({ status: "connecting" });

    const result = await Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStart", [agent.package]]);

    if (result == "executed") {
      if (!Acp.connection) {
        const stream = Acp.createStream();

        Acp.connection = Acp.buildApp().connect(stream);
      }

      Acp.callAgent(AcpSDK.methods.agent.initialize, {
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
      }).then(initialize => {
        if (!initialize) return;

        initialize.authMethods = initialize.authMethods?.filter(m => m.type !== "env_var");
        Acp.setState({ ...Acp.state, initialize, status: "connected" });
        Acp.listSession();
      });
    } else {
      Acp.setState({ ...Acp.state, status: result === "initialized" ? "connected" : "disconnected" });
    }
  }

  static listSession() {
    if (!Acp.connection) return;

    if (Acp.state.initialize?.agentCapabilities?.sessionCapabilities?.list) {
      Acp.setState({ ...Acp.state, status: "processing" });
      Acp.callAgent(AcpSDK.methods.agent.session.list, { cwd: Acp.workspace.current.cwd }).then(response => {
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

  static async onCreateSession() {
    if (!Acp.connection) return;

    Acp.setState({ ...Acp.state, status: "processing" });

    if (Acp.state.sessionId && Acp.state.initialize?.agentCapabilities?.sessionCapabilities?.close) {
      await Acp.connection.agent.request(AcpSDK.methods.agent.session.close, { sessionId: Acp.state.sessionId });
    }

    return Acp.callAgent(AcpSDK.methods.agent.session.new, {
      cwd: Acp.workspace.current.cwd,
      mcpServers: await Mcp.servers(),
    }).then(response => {
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

  static onStopAgent() {
    Acp.setState({ status: "disconnected" });

    Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStop", []]);
  }

  static onAuthenticate(methodId: string) {
    if (!Acp.connection) return;

    Acp.setState({ ...Acp.state, status: "connecting" });
    Acp.callAgent(AcpSDK.methods.agent.authenticate, { methodId }).then(() => {
      Acp.setState({ ...Acp.state, status: "connected" });
      Acp.listSession();
    });
  }

  static onLogout() {
    if (!Acp.connection) return;

    Acp.callAgent(AcpSDK.methods.agent.logout, {}).then(() => {
      Acp.setState({ ...Acp.state, status: "auth_required" });
    });
  }

  static onCleanup() {
    Acp.cancelAllPermissions();
    Acp.tool = {};
    Acp.sessions = Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== Acp.workspace.current.name));

    Acp.setState({ status: "disconnected" });
    Acp.notifySessionUpdate();
  }

  static onDeleteSession(sessionId: string) {
    if (!Acp.connection) return;

    Acp.callAgent(AcpSDK.methods.agent.session.delete, { sessionId });
    delete(Acp.sessions[sessionId]);

    if (Acp.state.sessionId === sessionId) {
      delete(Acp.state.sessionId);
    }

    Acp.setState({ status: "connected" });
    Acp.notifySessionUpdate();
  }

  static async onSwitchSession(sessionId: string) {
    const session = Acp.sessions[sessionId];

    if (!session || !Acp.connection) return;

    if (Acp.state.sessionId && Acp.state.initialize?.agentCapabilities?.sessionCapabilities?.close) {
      await Acp.connection.agent.request(AcpSDK.methods.agent.session.close, { sessionId: Acp.state.sessionId });
    }

    if (
      (session.loaded && Acp.state.initialize?.agentCapabilities?.sessionCapabilities?.resume) ||
      (!session.loaded && Acp.state.initialize?.agentCapabilities?.loadSession)
    ) {
      const mcpServers = await Mcp.servers();
      const method = session.loaded ? AcpSDK.methods.agent.session.resume : AcpSDK.methods.agent.session.load;

      Acp.setState({ ...Acp.state, status: "processing", sessionId });
      Acp.callAgent(method, {
        sessionId, cwd: Acp.workspace.current.cwd, mcpServers
      }).then(response => {
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
    const update = notification.update;
    const isChunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk";

    if (isChunk) {
      if (!update.messageId) {
        const key = `${update.sessionUpdate}_${update.content.type}`;

        update.messageId = Acp.lastMessageId[key] || `msg_${randomBytes(8).toString("hex")}`;
        Acp.lastMessageId = { [key]: update.messageId };
      }
    }

    Emit.send("acp:message-added", notification);
  }

  static onSendPrompt(sessionId: string, text: string, files: string[] = [], images: AcpSDK.ImageContent[] = []) {
    Acp.lastMessageId = {};

    if (!sessionId) {
      Acp.onCreateSession()?.then(() => Acp.onSendPrompt(Acp.state.sessionId!, text, files, images));
      return;
    }

    if (!Acp.connection || !Acp.sessions[sessionId]) return;

    const prompt: AcpSDK.ContentBlock[] = [
      ...(text ? [{ type: "text" as "text", text }] : []),
      ...files.map(file => ({ type: "resource_link" as "resource_link", uri: `file://${file}`, name: file.split("/").pop() || file })),
      ...(Acp.state.initialize?.agentCapabilities?.promptCapabilities?.image ? images.map(image => ({ ...image, type: "image" as "image" })) : [] ),
    ];

    prompt.forEach(content => Acp.addMessage({ sessionId, update: { sessionUpdate: "user_message_chunk", content }}));
    Acp.setState({ ...Acp.state, status: "processing" });
    Acp.callAgent(AcpSDK.methods.agent.session.prompt, { sessionId, prompt }).then(result => {
      if (!result) return;

      if (result && result.stopReason !== "end_turn") {
        Acp.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.stopReason } } });
      }
      Acp.tool = {};
      Acp.cancelAllPermissions();
      Acp.setState({ ...Acp.state, status: "connected" });
    });
  }

  static onCancelPrompt(sessionId: string) {
    if (!Acp.connection) return;

    Acp.cancelAllPermissions();

    Acp.connection.agent.notify(AcpSDK.methods.agent.session.cancel, { sessionId }).catch(err => {
      Acp.setState({ ...Acp.state, status: "connected", error: err instanceof Error ? err.message : String(err) });
    });
  }


  private static notifySessionUpdate(): void {
    Emit.update("acp:session-update", false, Acp.state.sessionId, Object.values(Acp.sessions));
  }

  private static onPlanUpdate(params: AcpSDK.SessionNotification): boolean {
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

  private static onAvailableCommandsUpdate(params: AcpSDK.SessionNotification): boolean {
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

  private static onConfigOptionUpdate(params: AcpSDK.SessionNotification): boolean {
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

  private static onSessionInfoUpdate(params: AcpSDK.SessionNotification): boolean {
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

  private static onUsageUpdate(params: AcpSDK.SessionNotification): boolean {
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

  private static async onReadTextFile(params: AcpSDK.ReadTextFileRequest): Promise<AcpSDK.ReadTextFileResponse> {
    const lines = await Emit.share("envim:api", "nvim_call_function", ["readfile", [params.path]]);

    return { content: Array.isArray(lines) ? lines.join("\n") : "" };
  }

  private static async onWriteTextFile(params: AcpSDK.WriteTextFileRequest): Promise<AcpSDK.WriteTextFileResponse> {
    await Emit.share("envim:api", "nvim_call_function", ["writefile", [params.content.split("\n"), params.path]]);

    return {};
  }

  private static async onCreateTerminal(params: AcpSDK.CreateTerminalRequest): Promise<AcpSDK.CreateTerminalResponse> {
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

  private static async onTerminalOutputRequest(params: AcpSDK.TerminalOutputRequest): Promise<AcpSDK.TerminalOutputResponse> {
    const terminal = Acp.terminal[params.terminalId]!;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.pid ? undefined : { exitCode: 0 },
    };
  }

  private static async onWaitForTerminalExit(params: AcpSDK.WaitForTerminalExitRequest): Promise<AcpSDK.WaitForTerminalExitResponse> {
    return Acp.terminal[params.terminalId].promise;
  }

  private static async onKillTerminal(params: AcpSDK.KillTerminalRequest): Promise<AcpSDK.KillTerminalResponse> {
    const { pid } = Acp.terminal[params.terminalId];

    Emit.share("envim:api", "nvim_call_function", ["jobstop", [pid]]);

    return {};
  }

  private static async onReleaseTerminal(params: AcpSDK.ReleaseTerminalRequest): Promise<AcpSDK.ReleaseTerminalResponse> {
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
    Emit.on("acp:exited", Acp.onCleanup);

    return AcpSDK.ndJsonStream(webWritable, webReadable);
  }

  private static buildApp() {
    return AcpSDK.client({ name: "Envim" })
      .onRequest(AcpSDK.methods.client.fs.readTextFile, ctx => Acp.onReadTextFile(ctx.params))
      .onRequest(AcpSDK.methods.client.fs.writeTextFile, ctx => Acp.onWriteTextFile(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.create, ctx => Acp.onCreateTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.output, ctx => Acp.onTerminalOutputRequest(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.waitForExit, ctx => Acp.onWaitForTerminalExit(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.kill, ctx => Acp.onKillTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.release, ctx => Acp.onReleaseTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.session.requestPermission, ctx => Acp.onRequestPermission(ctx.params))
      .onNotification(AcpSDK.methods.client.session.update, ctx => Acp.onSessionUpdate(ctx.params));
  }

  private static async onRequestPermission(params: AcpSDK.RequestPermissionRequest): Promise<AcpSDK.RequestPermissionResponse> {
    const requestId = `perm_${randomBytes(16).toString("hex")}`;

    params.toolCall._meta = params.toolCall._meta || {};
    params.toolCall._meta.permissionRequest = { requestId, options: params.options };
    Acp.processToolUpdate(Acp.state.sessionId!, params.toolCall);

    return new Promise((resolve) => Acp.permission[requestId] = resolve);
  }

  static onPermissionResponse(requestId: string, optionId: string): void {
    const resolver = Acp.permission[requestId];
    const outcome = optionId ? "selected" : "cancelled";

    if (!resolver) {
      return;
    }

    resolver({ outcome: { outcome, optionId } });
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

  private static cancelAllPermissions() {
    Object.keys(Acp.permission).forEach(requestId => {
      Acp.onPermissionResponse(requestId, "");
    });
  }
}
