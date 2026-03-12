import {
  Client,
  ClientSideConnection,
  ContentBlock,
  ToolCallUpdate,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ndJsonStream
} from "@agentclientprotocol/sdk";

import { IPermissionRequest, IAcpStatus, IAcpSession  } from "common/interface";

import { Emit } from "../emit";
import { Setting } from "../setting";

export class Acp {
  private static initialized = false;
  private static state: IAcpStatus = { status: "disconnected", plan: [] };
  private static workspace: { current: string; state: { [k: string]: IAcpStatus } } = { current: "default", state: {} };
  private static connection: ClientSideConnection | null = null;
  private static sessions: { [key: string]: IAcpSession } = {};
  private static tool: { [key: string]: ToolCallUpdate } = {};
  private static permission: { [key: string]: (response: RequestPermissionResponse) => void } = {};

  static async setup(init: boolean, workspace: string) {
    if (!Acp.initialized) {
      Acp.initialized = true;
      Emit.on("acp:start-agent", Acp.startAgent);
      Emit.on("acp:stop-agent", Acp.stopAgent);
      Emit.on("acp:create-session", Acp.createSession);
      Emit.on("acp:switch-session", Acp.setActiveSession);
      Emit.on("acp:delete-session", Acp.deleteSession);
      Emit.on("acp:send-prompt", Acp.sendPrompt);
      Emit.on("acp:cancel-prompt", Acp.cancelPrompt);
      Emit.on("acp:permission-response", Acp.handlePermissionResponse);
      Emit.on("acp:set-session-mode", Acp.onSetSessionMode);
      Emit.on("acp:set-session-model", Acp.onSetSessionModel);
    }

    Acp.workspace.state[Acp.workspace.current] = Acp.state;
    Acp.workspace.current = workspace;
    Acp.sessions = !init ? Acp.sessions : Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== workspace));

    Object.values(Acp.sessions).forEach(s => s.status = s.workspace === Acp.workspace.current ? "show" : "hide");

    Acp.setState((!init && Acp.workspace.state[workspace]) || { status: "disconnected", plan: [] });
    Acp.notifySessionUpdate();
    Emit.share("envim:luafile", "acp.lua");
  }

  private static onSetSessionMode(mode: string) {
    if (!Acp.connection || !Acp.state.sessionId) {
      return;
    }

    Acp.connection.setSessionMode({
      sessionId: Acp.state.sessionId,
      modeId: mode
    });

    const session = Acp.sessions[Acp.state.sessionId];
    if (session?.modes) {
      session.modes.currentModeId = mode;
    }

    Acp.notifySessionUpdate();
  }

  private static onSetSessionModel(modelId: string) {
    if (!Acp.connection || !Acp.state.sessionId) {
      return;
    }

    Acp.connection.unstable_setSessionModel({
      sessionId: Acp.state.sessionId,
      modelId
    });

    const session = Acp.sessions[Acp.state.sessionId];
    if (session?.models) {
      session.models.currentModelId = modelId;
    }

    Acp.notifySessionUpdate();
  }

  private static setState(state: IAcpStatus) {
    Acp.state = state;

    Emit.update("acp:status-changed", false, Acp.state);
  }

  private static handleSessionUpdate(params: SessionNotification): void {
    if (!params.sessionId || params.sessionId !== Acp.state.sessionId) return;

    if (
      !Acp.handleToolCallUpdate(params) &&
      !Acp.handlePlanUpdate(params) &&
      !Acp.handleAvailableCommandsUpdate(params) &&
      !Acp.handleSessionInfoUpdate(params) &&
      !Acp.handleUsageUpdate(params)
    ) {
      Acp.addMessage(params);
    }

    Acp.notifySessionUpdate();
  }

  private static processToolUpdate(sessionId: string, toolCall: ToolCallUpdate) {
    toolCall._meta = toolCall._meta || {};

    Object.keys(Acp.tool[toolCall.toolCallId] || {}).forEach(k => toolCall[k] = toolCall[k] || Acp.tool[toolCall.toolCallId][k]);
    Object.keys((Acp.tool[toolCall.toolCallId]?._meta) || {}).forEach(k => toolCall._meta![k] = toolCall._meta![k] || Acp.tool[toolCall.toolCallId]._meta![k]);

    if (!toolCall._meta.start && toolCall.status !== "pending") {
      toolCall._meta.start = Date.now();
    }
    if (toolCall.status !== "pending") {
      toolCall._meta.executionTime = ((Date.now() - (toolCall._meta!.start as number)) / 1000).toFixed(1);
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

  private static handleToolCallUpdate(params: SessionNotification): boolean {
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return false;
    }

    Acp.processToolUpdate(params.sessionId, params.update);

    return true;
  }



  static async startAgent() {
    Acp.setState({ status: "connecting", plan: [] });

    const result = await Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStart", [Setting.get().acp.command]]);

    if (result == "executed") {
      if (!Acp.connection) {
        Acp.connection = new ClientSideConnection(
          () => Acp.createClient(),
          Acp.createStream()
        );
      }

      Acp.connection.initialize({
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
      }).then(Acp.createSession);
    } else {
      Acp.setState({ status: result === "initialized" ? "connected" : "disconnected", plan: [] });
    }
  }

  static async createSession() {
    if (!Acp.connection) {
      return;
    }

    const sessionResponse = await Acp.connection.newSession({
      cwd: "",
      mcpServers: (Setting.get().acp.mcpServers || []).filter(mcp => mcp.enabled).map(({ server }) => server),
    });

    const session: IAcpSession = {
      id: sessionResponse.sessionId,
      name: `Session ${new Date().toLocaleTimeString()}`,
      workspace: Acp.workspace.current,
      status: "show",
      modes: sessionResponse.modes,
      models: sessionResponse.models,
      commands: []
    };

    Acp.sessions[session.id] = session;
    Acp.setState({ ...Acp.state, status: "connected", sessionId: session.id });
    Acp.notifySessionUpdate();
  }

  static stopAgent() {
    Acp.setState({ status: "disconnected", plan: [] });

    Emit.share("envim:api", "nvim_call_function", ["EnvimAcpStop", []]);
  }


  static cleanup() {
    Acp.tool = {};
    Acp.permission = {};
    Acp.sessions = Object.fromEntries(Object.entries(Acp.sessions).filter(([_, s]) => s.workspace !== Acp.workspace.current));

    Acp.setState({ status: "disconnected", plan: [] });
    Acp.notifySessionUpdate();
  }

  static async deleteSession(sessionId: string): Promise<void> {
    delete Acp.sessions[sessionId];

    if (Acp.state.sessionId === sessionId) {
      delete(Acp.state.sessionId);
    }

    Acp.notifySessionUpdate();
  }

  static async setActiveSession(sessionId: string): Promise<void> {
    const session = Acp.sessions[sessionId];

    if (!session) {
      return;
    }

    Acp.setState({ ...Acp.state, sessionId });
    Acp.notifySessionUpdate();
  }


  static addMessage(notification: SessionNotification) {
    Emit.send("acp:message-added", notification);
  }

  static async sendPrompt(sessionId: string, text: string, files: string[] = []) {
    if (!Acp.connection) {
      return;
    }

    const prompt: ContentBlock[] = [
      { type: "text", text },
      ...files.map(file => ({ type: "resource_link", uri: `file://${file}`, name: file.split("/").pop() || file } as ContentBlock)),
    ];

    prompt.forEach(content => Acp.addMessage({ sessionId, update: { sessionUpdate: "user_message_chunk", content }}));
    Acp.setState({ ...Acp.state, status: "processing" });
    Acp.connection.prompt({
      sessionId,
      prompt
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Acp.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Failed to send message: ${errorMessage}` } } });
    }).then(result => {
      if (result && result.stopReason !== "end_turn") {
        Acp.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.stopReason } } });
      }
    }).finally(() => {
      Acp.tool = {};
      Acp.permission = {};
      Acp.setState({ ...Acp.state, status: "connected" });
    });
  }

  static async cancelPrompt(sessionId: string) {
    if (!Acp.connection) {
      return;
    }

    Acp.setState({ ...Acp.state, status: "processing" });
    Acp.connection.cancel({ sessionId });
    Acp.addMessage({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "❌ Request cancelled by user"  } } });
    Acp.setState({ ...Acp.state, status: "connected" });
  }


  private static notifySessionUpdate(): void {
    Emit.update("acp:session-update", false, Acp.state.sessionId, Object.values(Acp.sessions));
  }

  private static handlePlanUpdate(params: SessionNotification): boolean {
    if (params.update.sessionUpdate !== "plan") {
      return false;
    }

    Acp.setState({ ...Acp.state, plan: params.update.entries });

    return true;
  }

  private static handleAvailableCommandsUpdate(params: SessionNotification): boolean {
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

  private static handleSessionInfoUpdate(params: SessionNotification): boolean {
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

  private static handleUsageUpdate(params: SessionNotification): boolean {
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

  private static async handleReadTextFile(params: { path: string }): Promise<{ content: string }> {
    const lines = await Emit.share("envim:api", "nvim_call_function", ["readfile", [params.path]]);

    return { content: Array.isArray(lines) ? lines.join("\n") : "" };
  }

  private static async handleWriteTextFile(params: { path: string; content: string }): Promise<{}> {
    await Emit.share("envim:api", "nvim_call_function", ["writefile", [params.content.split("\n"), params.path]]);

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

    return ndJsonStream(webWritable, webReadable);
  }

  private static async handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `perm_${Date.now()}`;

    params.toolCall._meta = params._meta || {};
    params.toolCall._meta.permissionRequest = { requestId, options: params.options };
    Acp.processToolUpdate(Acp.state.sessionId!, params.toolCall);

    return new Promise((resolve) => Acp.permission[requestId] = resolve);
  }

  static handlePermissionResponse(requestId: string, optionId: string): void {
    const tool = Object.values(Acp.tool).find(t => {
      const permissionRequest = t._meta?.permissionRequest as IPermissionRequest | undefined;
      return permissionRequest?.requestId === requestId;
    });
    const resolver = Acp.permission[requestId];

    if (tool && resolver) {
      resolver({ outcome: { outcome: "selected", optionId } });
      delete(Acp.tool[tool.toolCallId]._meta!.permissionRequest);
      delete(Acp.permission[requestId]);
    }
  }

  private static createClient(): Client {
    return {
      readTextFile: async (params: any) => await Acp.handleReadTextFile(params),
      writeTextFile: async (params: any) => await Acp.handleWriteTextFile(params),
      terminal: async (_params: any) => ({ exitCode: 0, stdout: "", stderr: "" }),
      requestPermission: async (params: RequestPermissionRequest) => Acp.handleRequestPermission(params),
      sessionUpdate: async (params: SessionNotification) => Acp.handleSessionUpdate(params)
    };
  }
}
