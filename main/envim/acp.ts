import {
  Client,
  ClientSideConnection,
  ContentBlock,
  ToolCallContent,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ndJsonStream,
  PermissionOption
} from "@agentclientprotocol/sdk";

import { IAcpStatus, IAcpSession, IAcpMessage, IAcpToolCall } from "common/interface";

import { Emit } from "../emit";
import { Setting } from "../setting";

export class Acp {
  private static initialized = false;
  private static state: IAcpStatus = { status: "disconnected", plan: [] };
  private static workspace: { current: string; state: { [k: string]: IAcpStatus } } = { current: "default", state: {} };
  private static connection: ClientSideConnection | null = null;
  private static sessions: { [key: string]: IAcpSession } = {};
  private static tool: { [key: string]: IAcpToolCall } = {};
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
      const content = Acp.parseUpdateContent(params);

      if (content?.trim()) {
        Acp.addMessage(params.sessionId, params.update.sessionUpdate, content);
      }
    }

    Acp.notifySessionUpdate();
  }

  private static parseUpdateContent(params: SessionNotification) {
    if ("content" in params.update && params.update.content) {
      const contents = Array.isArray(params.update.content) ? params.update.content : [params.update.content];
      const genContent = (message: string, content: ContentBlock | ToolCallContent) => {
        if (content.type === "text") {
          message = `${message}${content.text || ""}`;
        } else if (content.type === "image") {
          message = `${message}[Image: ${content.mimeType}]`;
        } else if (content.type === "resource_link") {
          message = `${message}[${content.name}: ${content.uri}]`;
        } else if (content.type === "resource") {
          message = `${message}[Resource: ${content.resource.uri}]`;
        } else {
          message = `[${content.type}]`;
        }

        return message;
      };

      return contents.reduce(genContent, "");
    }

    return "";
  }

  private static processToolUpdate(sessionId: string, toolCall: RequestPermissionRequest["toolCall"], permissionOptions?: PermissionOption[]): IAcpMessage["toolInfo"] {
    if (toolCall.toolCallId in Acp.tool) {
      const tool = Acp.tool[toolCall.toolCallId];
      tool.status = toolCall.status || tool.status;
      if (!tool.start && toolCall.status === "in_progress") {
        tool.start = Date.now();
      }
    } else {
      Acp.tool[toolCall.toolCallId] = {
        id: toolCall.toolCallId,
        title: toolCall.title || toolCall.toolCallId,
        status: toolCall.status || "pending",
        start: Date.now(),
      };
    }

    const tool = Acp.tool[toolCall.toolCallId];
    const executionTime = toolCall.status !== "pending"
      ? ` (${((Date.now() - tool.start) / 1000).toFixed(1)}s)`
      : "";
    const content = `${tool.title}${executionTime}`;
    const toolInfo = Acp.mapToToolInfo(toolCall, permissionOptions);

    tool.permissionRequest = toolInfo?.permissionRequest;
    Acp.addMessage(sessionId, "tool", content, toolInfo);

    if (toolCall.status === "completed" || toolCall.status === "failed") {
      delete(Acp.tool[toolCall.toolCallId]);
    }

    return toolInfo;
  }

  private static handleToolCallUpdate(params: SessionNotification): boolean {
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return false;
    }

    Acp.processToolUpdate(params.sessionId, params.update);

    return true;
  }

  private static mapToToolInfo(toolCall: RequestPermissionRequest["toolCall"], permissionOptions?: PermissionOption[]): IAcpMessage["toolInfo"] {
    const toolInfo: IAcpMessage["toolInfo"] = {
      id: toolCall.toolCallId,
      status: toolCall.status || "pending",
      content: "",
      diff: { add: "", delete: "" },
    };

    if (toolCall.content && Array.isArray(toolCall.content)) {
      toolCall.content.forEach(current => {
        if (current.type === "diff") {
          toolInfo.diff.add += current.newText;
          toolInfo.diff.delete += current.oldText;
        } else if (current.type === "content") {
          if (current.content.type === "text") {
            toolInfo.content += current.content.text;
          } else if (current.content.type === "resource") {
            toolInfo.content = [toolInfo.content, current.content.resource.uri].filter(str => str).join("\n");
          } else if (current.content.type === "resource_link") {
            toolInfo.content = [toolInfo.content, current.content.uri].filter(str => str).join("\n");
          }
        } else if (current.type === "terminal") {
          toolInfo.content = [toolInfo.content, "[Terminal Output]"].filter(str => str).join("\n");
        }
      });
    } else if (toolCall.rawInput && Object.keys(toolCall.rawInput).length) {
      toolInfo.content = JSON.stringify(toolCall.rawInput);
    }

    if (permissionOptions) {
      toolInfo.permissionRequest = {
        requestId: `perm_${Date.now()}`,
        options: permissionOptions,
      };
    }

    return toolInfo;
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


  static addMessage(sessionId: string, type: string, content: string, toolInfo?: IAcpMessage["toolInfo"]): void {
    const session = Acp.sessions[sessionId];
    if (!session || (!content && !toolInfo)) {
      return;
    }

    const message: IAcpMessage = {
      sessionId,
      type,
      content,
      toolInfo,
    };

    Emit.send("acp:message-added", message);
  }

  static async sendPrompt(sessionId: string, text: string, files: string[] = []) {
    if (!Acp.connection) {
      return;
    }

    const prompt: ContentBlock[] = [{ type: "text", text }];

    files.forEach(file => prompt.push({ type: "resource_link", uri: `file://${file}`, name: file.split("/").pop() || file }));

    Acp.addMessage(sessionId, "user_message_chunk", text);
    Acp.setState({ ...Acp.state, status: "processing" });
    Acp.connection.prompt({
      sessionId,
      prompt
    }).catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Acp.addMessage(sessionId, "system", `Failed to send message: ${errorMessage}`);
    }).then(result => {
      if (result && result.stopReason !== "end_turn") {
        Acp.addMessage(sessionId, "system", result.stopReason);
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
    Acp.addMessage(sessionId, "system", "❌ Request cancelled by user");
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
    const toolInfo = Acp.processToolUpdate(Acp.state.sessionId!, params.toolCall, params.options);

    return new Promise((resolve) => {
      Acp.permission[toolInfo!.permissionRequest!.requestId] = resolve;
    });
  }

  static handlePermissionResponse(requestId: string, optionId: string): void {
    const tool = Object.values(Acp.tool)
    .find(t => t.permissionRequest?.requestId === requestId);
    const resolver = Acp.permission[requestId];
    const option = tool?.permissionRequest?.options.find(opt => opt.optionId === optionId);

    if (tool && resolver && option) {
      resolver({ outcome: { outcome: "selected", optionId } });
      delete(Acp.tool[tool.id]);
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
