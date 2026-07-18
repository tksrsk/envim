import { randomBytes } from "crypto";
import * as AcpSDK from "@agentclientprotocol/sdk";

import { IAcpRegistry, IAcpRegistryAgent, IPermissionRequest, IAcpStatus, IAcpSession } from "common/interface";

import { Mcp } from "main/mcp";
import { Workspace } from "main/envim/workspace";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export class Acp {
  private static registry: IAcpRegistry = { npx: [], uvx: [], binary: [] };
  private static registryLoaded = false;

  private state: IAcpStatus = { status: "disconnected" };
  private connection: AcpSDK.ClientConnection | null = null;
  private sessions: { [key: string]: IAcpSession } = {};
  private tool: { [key: string]: AcpSDK.ToolCallUpdate } = {};
  private terminal: { [key: string]: { promise: Promise<AcpSDK.WaitForTerminalExitResponse>, output: string, truncated: boolean, pid: number, resolve?: (response: AcpSDK.WaitForTerminalExitResponse) => void } } = {};
  private permission: { [key: string]: (response: AcpSDK.RequestPermissionResponse) => void } = {};
  private lastMessageId: { [k: string]: string } = {};
  private stdoutPush?: (data: string) => void;

  constructor(private readonly workspace: Workspace) {
    this.workspace.emit.share("neovim:luafile", "acp.lua");
    this.workspace.emit.on("acp:agent:start", this.onAcpAgentStart);
    this.workspace.emit.on("acp:agent:stop", this.onAcpAgentStop);
    this.workspace.emit.on("acp:auth:authenticate", this.onAcpAuthAuthenticate);
    this.workspace.emit.on("acp:auth:logout", this.onAcpAuthLogout);
    this.workspace.emit.on("acp:error", this.onAcpError);
    this.workspace.emit.on("acp:exited", this.onAcpExited);
    this.workspace.emit.on("acp:permission:response", this.onAcpPermissionResponse);
    this.workspace.emit.on("acp:prompt:cancel", this.onAcpPromptCancel);
    this.workspace.emit.on("acp:prompt:send", this.onAcpPromptSend);
    this.workspace.emit.on("acp:session:config", this.onAcpSessionConfig);
    this.workspace.emit.on("acp:session:create", this.onAcpSessionCreate);
    this.workspace.emit.on("acp:session:delete", this.onAcpSessionDelete);
    this.workspace.emit.on("acp:session:switch", this.onAcpSessionSwitch);
    this.workspace.emit.on("acp:stdout", this.onAcpStdout);
    this.workspace.emit.on("acp:terminal:exit", this.onAcpTerminalExit);
    this.workspace.emit.on("acp:terminal:output", this.onAcpTerminalOutput);
    this.workspace.emit.on("acp:toggle", this.onAcpToggle);
  }

  private setState(state: IAcpStatus) {
    this.state = state;

    this.workspace.emit.update("acp:status:changed", false, this.state);
  }

  private async loadRegistry() {
    if (!Acp.registryLoaded) {
      const response = await fetch(ACP_REGISTRY_URL);

      if (response.ok) {
        const support = await this.workspace.emit.share("neovim:function", "EnvimAcpBinarySupport", []) as {
          npx?: boolean;
          uvx?: boolean;
          platform?: string;
          tar?: boolean;
          unzip?: boolean;
        };
        Acp.registry = ((await response.json() as { agents: IAcpRegistryAgent[] }).agents)
          .reduce<IAcpRegistry>((registry, agent) => {
            if (!agent.name || !agent.distribution) return registry;

            const { npx, uvx, binary: binaries } = agent.distribution;
            const binary = support.platform ? binaries?.[support.platform] : undefined;
            const extension = binary?.archive.replace(/[?#].*$/, "").replace(/\.(?:tar\.[a-z0-9]+|tgz)$/i, ".tar").match(/\.([a-z0-9]+)$/i)?.pop()?.toLowerCase();
            const format = extension === "tar" || extension === "zip" ? extension : "binary";

            if (support.npx && npx) {
              registry.npx.push({
                ...agent,
                package: {
                  command: ["npx", "--yes", npx.package, ...(npx.args || [])],
                  ...(npx.env ? { env: npx.env } : {})
                }
              });
            } else if (support.uvx && uvx) {
              registry.uvx.push({
                ...agent,
                package: {
                  command: ["uvx", uvx.package, ...(uvx.args || [])],
                  ...(uvx.env ? { env: uvx.env } : {})
                }
              });
            } else if (binary && (format === "binary" || (format === "tar" && support.tar) || (format === "zip" && support.unzip))) {
              registry.binary.push({
                ...agent,
                package: {
                  command: [binary.cmd, ...(binary.args || [])],
                  ...(binary.env ? { env: binary.env } : {}),
                  archive: binary.archive
                }
              });
            }

            return registry;
          }, { npx: [], uvx: [], binary: [] });
        Object.values(Acp.registry).forEach(agents => agents.sort((a, b) => a.name.localeCompare(b.name)));
        Acp.registryLoaded = true;
      }
    }

    return Acp.registry;
  }

  private onSessionUpdate(params: AcpSDK.SessionNotification): void {
    if (!params.sessionId || params.sessionId !== this.state.sessionId) return;

    if (
      !this.onToolCallUpdate(params) &&
      !this.onPlanUpdate(params) &&
      !this.onAvailableCommandsUpdate(params) &&
      !this.onConfigOptionUpdate(params) &&
      !this.onSessionInfoUpdate(params) &&
      !this.onUsageUpdate(params)
    ) {
      this.addMessage(params);
    }

    this.notifySessionUpdate();
  }

  private processToolUpdate(sessionId: string, toolCall: AcpSDK.ToolCallUpdate) {
    toolCall._meta = toolCall._meta || {};

    Object.keys(this.tool[toolCall.toolCallId] || {}).forEach(k => toolCall[k] = toolCall[k] || this.tool[toolCall.toolCallId][k]);
    Object.keys((this.tool[toolCall.toolCallId]?._meta) || {}).forEach(k => toolCall._meta![k] = toolCall._meta![k] || this.tool[toolCall.toolCallId]._meta![k]);

    if (!toolCall._meta.start && toolCall.status !== "pending") {
      toolCall._meta.start = Date.now();
    }
    if (toolCall.status !== "pending" && toolCall._meta.start) {
      toolCall._meta.executionTime = ((Date.now() - (toolCall._meta.start as number)) / 1000).toFixed(1);
    }

    this.tool[toolCall.toolCallId] = toolCall;

    this.addMessage({
      sessionId,
      update: { sessionUpdate: "tool_call_update", ...toolCall }
    });

    if (toolCall.status === "completed" || toolCall.status === "failed") {
      delete(this.tool[toolCall.toolCallId]);
    }
  }

  private onToolCallUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return false;
    }

    this.processToolUpdate(params.sessionId, params.update);

    return true;
  }

  private callAgent<M extends AcpSDK.AgentRequestMethod>(
    method: M,
    params: AcpSDK.AgentRequestParamsByMethod[M],
  ): Promise<AcpSDK.AgentRequestResponsesByMethod[M] | void> {
    if (!this.connection) return Promise.resolve();

    this.setState({ ...this.state, error: undefined });

    return (this.connection.agent.request(method, params)).catch(err => {
      const error = err instanceof Error ? err.message : String(err);
      const autherror = this.state.initialize?.authMethods?.length && err instanceof AcpSDK.RequestError && err.code === -32000;
      const status = autherror ? "auth_required" : "connected";

      this.setState({ ...this.state, status, error });
    });
  }

  private onAcpAgentStart = async (agent: IAcpRegistryAgent) => {
    this.setState({ status: "connecting", agent });

    const result = await this.workspace.emit.share("neovim:function", "EnvimAcpStart", [agent.package, agent.name, agent.version]);

    if (result == "executed") {
      if (!this.connection) {
        const stream = this.createStream();

        this.connection = this.buildApp().connect(stream);
      }

      this.callAgent(AcpSDK.methods.agent.initialize, {
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

        initialize.authMethods = initialize.authMethods?.filter(m => !("type" in m) || m.type !== "env_var");
        this.setState({ ...this.state, initialize, status: "connected" });
        this.listSession();
      });
    } else {
      this.setState({ ...this.state, status: result === "initialized" ? "connected" : "disconnected" });
    }
  }

  private onAcpAgentStop = () => {
    this.setState({ status: "disconnected" });

    this.workspace.emit.share("neovim:function", "EnvimAcpStop", []);
  }

  private onAcpAuthAuthenticate = (methodId: string) => {
    if (!this.connection) return;

    this.setState({ ...this.state, status: "connecting" });
    this.callAgent(AcpSDK.methods.agent.authenticate, { methodId }).then(() => {
      this.setState({ ...this.state, status: "connected" });
      this.listSession();
    });
  }

  private onAcpAuthLogout = () => {
    if (!this.connection) return;

    this.callAgent(AcpSDK.methods.agent.logout, {}).then(() => {
      this.setState({ ...this.state, status: "auth_required" });
    });
  }

  private onAcpError = (error: string) => {
    this.setState({ ...this.state, error });
  }

  private onAcpExited = () => {
    this.cancelAllPermissions();
    this.tool = {};
    this.sessions = {};

    this.setState({ status: "disconnected" });
    this.notifySessionUpdate();
  }

  private onAcpPermissionResponse = (requestId: string, optionId: string): void => {
    const resolver = this.permission[requestId];
    const outcome = optionId ? "selected" : "cancelled";

    if (!resolver) {
      return;
    }

    resolver({ outcome: { outcome, optionId } });
    delete(this.permission[requestId]);

    const tool = Object.values(this.tool).find(t => {
      const permissionRequest = t._meta?.permissionRequest as IPermissionRequest | undefined;
      return permissionRequest?.requestId === requestId;
    });

    if (tool) {
      delete(this.tool[tool.toolCallId]._meta!.permissionRequest);
      this.processToolUpdate(this.state.sessionId!, tool);
    }
  }

  private onAcpPromptCancel = (sessionId: string) => {
    if (!this.connection) return;

    this.cancelAllPermissions();

    this.connection.agent.notify(AcpSDK.methods.agent.session.cancel, { sessionId }).catch(err => {
      this.setState({ ...this.state, status: "connected", error: err instanceof Error ? err.message : String(err) });
    });
  }

  private onAcpPromptSend = (sessionId: string, text: string, files: string[] = [], images: AcpSDK.ImageContent[] = []) => {
    this.lastMessageId = {};

    if (!sessionId) {
      this.onAcpSessionCreate()?.then(() => this.onAcpPromptSend(this.state.sessionId!, text, files, images));
      return;
    }

    if (!this.connection || !this.sessions[sessionId]) return;

    const prompt: AcpSDK.ContentBlock[] = [
      ...(text ? [{ type: "text" as "text", text }] : []),
      ...files.map(file => ({ type: "resource_link" as "resource_link", uri: `file://${file}`, name: file.split("/").pop() || file })),
      ...(this.state.initialize?.agentCapabilities?.promptCapabilities?.image ? images.map(image => ({ ...image, type: "image" as "image" })) : [] ),
    ];

    prompt.forEach(content => this.addMessage({ sessionId, update: { sessionUpdate: "user_message_chunk", content }}));
    this.setState({ ...this.state, status: "processing" });
    this.callAgent(AcpSDK.methods.agent.session.prompt, { sessionId, prompt }).then(result => {
      if (!result) return;

      if (result && result.stopReason !== "end_turn") {
        this.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.stopReason } } });
      }
      this.tool = {};
      this.cancelAllPermissions();
      this.setState({ ...this.state, status: "connected" });
    });
  }

  private onAcpSessionConfig = (configId: string, value: string | boolean) => {
    if (!this.connection || !this.state.sessionId) return;

    const sessionId = this.state.sessionId;
    const params = typeof value === "boolean"
      ? { sessionId, configId, type: "boolean" as const, value }
      : { sessionId, configId, value };

    this.callAgent(AcpSDK.methods.agent.session.setConfigOption, params).then(response => {
      if (!response) return;

      const session = this.sessions[sessionId];
      if (session) {
        session.configOptions = response.configOptions;
        this.notifySessionUpdate();
      }
    });
  }

  private onAcpSessionCreate = async () => {
    if (!this.connection) return;

    this.setState({ ...this.state, status: "processing" });

    if (this.state.sessionId && this.state.initialize?.agentCapabilities?.sessionCapabilities?.close) {
      await this.connection.agent.request(AcpSDK.methods.agent.session.close, { sessionId: this.state.sessionId });
    }

    return this.callAgent(AcpSDK.methods.agent.session.new, {
      cwd: this.workspace.cwd,
      mcpServers: await Mcp.servers(this.workspace),
    }).then(response => {
      if (!response) return;

      const session: IAcpSession = {
        id: response.sessionId,
        name: `Session ${new Date().toLocaleTimeString()}`,
        loaded: true,
        status: "show",
        configOptions: response.configOptions || [],
        commands: [],
        plan: [],
      };

      this.sessions[session.id] = session;
      this.setState({ ...this.state, status: "connected", sessionId: session.id });
      this.notifySessionUpdate();
    });
  }

  private onAcpSessionDelete = (sessionId: string) => {
    if (!this.connection) return;

    this.callAgent(AcpSDK.methods.agent.session.delete, { sessionId });
    delete(this.sessions[sessionId]);

    this.setState({ ...this.state, status: "connected", ...(this.state.sessionId === sessionId ? { sessionId: undefined } : {}) });
    this.notifySessionUpdate();
  }

  private onAcpSessionSwitch = async (sessionId: string) => {
    const session = this.sessions[sessionId];

    if (!session || !this.connection) return;

    if (this.state.sessionId && this.state.initialize?.agentCapabilities?.sessionCapabilities?.close) {
      await this.connection.agent.request(AcpSDK.methods.agent.session.close, { sessionId: this.state.sessionId });
    }

    if (
      (session.loaded && this.state.initialize?.agentCapabilities?.sessionCapabilities?.resume) ||
      (!session.loaded && this.state.initialize?.agentCapabilities?.loadSession)
    ) {
      const mcpServers = await Mcp.servers(this.workspace);
      const method = session.loaded ? AcpSDK.methods.agent.session.resume : AcpSDK.methods.agent.session.load;

      this.setState({ ...this.state, status: "processing", sessionId });
      this.callAgent(method, {
        sessionId, cwd: this.workspace.cwd, mcpServers
      }).then(response => {
        if (!response) return;

        session.configOptions = response.configOptions || [];
        this.setState({ ...this.state, status: "connected" });
        this.notifySessionUpdate();
      });

      session.loaded = true;
    } else {
      this.setState({ ...this.state, sessionId });
      this.notifySessionUpdate();
    }
  }

  private onAcpStdout = (data: string) => {
    this.stdoutPush?.(data);
  }

  private onAcpTerminalExit = (data: { terminalId: string; exitCode: number; signal: string }) => {
    const terminal = this.terminal[data.terminalId];

    if (terminal?.resolve) {
      terminal.pid = 0;
      terminal.resolve(data);
    }
  }

  private onAcpTerminalOutput = (data: { terminalId: string; output: string }) => {
    const terminal = this.terminal[data.terminalId];

    if (terminal) {
      terminal.output = [terminal.output, data.output].filter(output => output).join("\n");
    }
  }

  private onAcpToggle = async (): Promise<void> => {
    this.workspace.emit.send("acp:toggle", await this.loadRegistry());
  }

  addMessage(notification: AcpSDK.SessionNotification) {
    const update = notification.update;
    const isChunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk";

    if (isChunk) {
      if (!update.messageId) {
        const key = `${update.sessionUpdate}_${update.content.type}`;

        update.messageId = this.lastMessageId[key] || `msg_${randomBytes(8).toString("hex")}`;
        this.lastMessageId = { [key]: update.messageId };
      }
    }

    this.workspace.emit.send("acp:message:added", notification);
  }

  private notifySessionUpdate(): void {
    this.workspace.emit.update("acp:session:update", false, this.state.sessionId, Object.values(this.sessions));
  }

  listSession() {
    if (!this.connection) return;

    if (this.state.initialize?.agentCapabilities?.sessionCapabilities?.list) {
      this.setState({ ...this.state, status: "processing" });
      this.callAgent(AcpSDK.methods.agent.session.list, { cwd: this.workspace.cwd }).then(response => {
        if (!response) return;

        response.sessions.forEach(session => {
          if (!this.sessions[session.sessionId]) {
            this.sessions[session.sessionId] = {
              id: session.sessionId,
              name: session.title || session.updatedAt || session.sessionId,
              loaded: false,
              status: "show",
              commands: [],
              configOptions: [],
              plan: [],
            };
          }
        });

        this.notifySessionUpdate();
        this.setState({ ...this.state, status: "connected" });
      });
    }
  }

  private onPlanUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "plan") {
      return false;
    }

    const session = this.sessions[params.sessionId];

    if (session) {
      session.plan = params.update.entries;
      this.notifySessionUpdate();
    }

    return true;
  }

  private onAvailableCommandsUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "available_commands_update") {
      return false;
    }

    const session = this.sessions[params.sessionId];

    if (session) {
      session.commands = params.update.availableCommands;
      this.notifySessionUpdate();
    }

    return true;
  }

  private onConfigOptionUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "config_option_update") {
      return false;
    }

    const session = this.sessions[params.sessionId];

    if (session) {
      session.configOptions = params.update.configOptions;
      this.notifySessionUpdate();
    }

    return true;
  }

  private onSessionInfoUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "session_info_update") {
      return false;
    }

    const session = this.sessions[params.sessionId];

    if (session && params.update.title) {
      session.name = params.update.title;
      this.notifySessionUpdate();
    }

    return true;
  }

  private onUsageUpdate(params: AcpSDK.SessionNotification): boolean {
    if (params.update.sessionUpdate !== "usage_update") {
      return false;
    }

    const session = this.sessions[params.sessionId];

    if (session) {
      session.usage = params.update;
      this.notifySessionUpdate();
    }

    return true;
  }

  private async onReadTextFile(params: AcpSDK.ReadTextFileRequest): Promise<AcpSDK.ReadTextFileResponse> {
    const lines = await this.workspace.emit.share("neovim:function", "readfile", [params.path]);

    return { content: Array.isArray(lines) ? lines.join("\n") : "" };
  }

  private async onWriteTextFile(params: AcpSDK.WriteTextFileRequest): Promise<AcpSDK.WriteTextFileResponse> {
    await this.workspace.emit.share("neovim:function", "writefile", [params.content.split("\n"), params.path]);

    return {};
  }

  private async onCreateTerminal(params: AcpSDK.CreateTerminalRequest): Promise<AcpSDK.CreateTerminalResponse> {
    const terminalId = `term__${Date.now()}`;
    const command = [params.command, ...(params.args || [])];
    const env = params.env?.reduce((envs, v) => ({ ...envs, [v.name]: v.value }), {} as Record<string, string>);
    const opts = { cwd: params.cwd || undefined, env };

    const pid = await this.workspace.emit.share("neovim:function", "EnvimAcpTerminalStart", [terminalId, command, opts]) as number | null;

    if (pid) {
      this.terminal[terminalId] = {
        promise: new Promise<AcpSDK.WaitForTerminalExitResponse>((resolve) => this.terminal[terminalId].resolve = resolve),
        output: "",
        truncated: false,
        pid,
      };
    }

    return { terminalId };
  }

  private async onAcpTerminalOutputRequest(params: AcpSDK.TerminalOutputRequest): Promise<AcpSDK.TerminalOutputResponse> {
    const terminal = this.terminal[params.terminalId]!;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.pid ? undefined : { exitCode: 0 },
    };
  }

  private async onWaitForTerminalExit(params: AcpSDK.WaitForTerminalExitRequest): Promise<AcpSDK.WaitForTerminalExitResponse> {
    return this.terminal[params.terminalId].promise;
  }

  private async onKillTerminal(params: AcpSDK.KillTerminalRequest): Promise<AcpSDK.KillTerminalResponse> {
    const { pid } = this.terminal[params.terminalId];

    this.workspace.emit.share("neovim:function", "jobstop", [pid]);

    return {};
  }

  private async onReleaseTerminal(params: AcpSDK.ReleaseTerminalRequest): Promise<AcpSDK.ReleaseTerminalResponse> {
    const { pid } = this.terminal[params.terminalId];

    await this.workspace.emit.share("neovim:function", "jobstop", [pid]);
    delete(this.terminal[params.terminalId]);

    return {};
  }

  private createStream() {
    const { Readable, Writable } = require("stream");

    const nodeReadable = new Readable({ read() {} });
    const nodeWritable = new Writable({
      write: (chunk: any, _encoding: any, callback: any) => {
        this.workspace.emit.share("neovim:function", "EnvimAcpSend", [chunk.toString()]);
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

    this.stdoutPush = (data: string) => {
      nodeReadable.push(`${data}\n`);
    };

    return AcpSDK.ndJsonStream(webWritable, webReadable);
  }

  private buildApp() {
    return AcpSDK.client({ name: "Envim" })
      .onRequest(AcpSDK.methods.client.fs.readTextFile, ctx => this.onReadTextFile(ctx.params))
      .onRequest(AcpSDK.methods.client.fs.writeTextFile, ctx => this.onWriteTextFile(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.create, ctx => this.onCreateTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.output, ctx => this.onAcpTerminalOutputRequest(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.waitForExit, ctx => this.onWaitForTerminalExit(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.kill, ctx => this.onKillTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.terminal.release, ctx => this.onReleaseTerminal(ctx.params))
      .onRequest(AcpSDK.methods.client.session.requestPermission, ctx => this.onRequestPermission(ctx.params))
      .onNotification(AcpSDK.methods.client.session.update, ctx => this.onSessionUpdate(ctx.params));
  }

  private async onRequestPermission(params: AcpSDK.RequestPermissionRequest): Promise<AcpSDK.RequestPermissionResponse> {
    const requestId = `perm_${randomBytes(16).toString("hex")}`;

    params.toolCall._meta = params.toolCall._meta || {};
    params.toolCall._meta.permissionRequest = { requestId, options: params.options };
    this.processToolUpdate(this.state.sessionId!, params.toolCall);

    return new Promise((resolve) => this.permission[requestId] = resolve);
  }

  private cancelAllPermissions() {
    Object.keys(this.permission).forEach(requestId => {
      this.onAcpPermissionResponse(requestId, "");
    });
  }
}
