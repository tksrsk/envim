import * as Electron from "electron";
import { readFileSync } from "fs";
import { Readable, Writable } from "stream";
import { spawn } from "child_process";
import { createConnection } from "net";
import Docker from "dockerode";
import { Client as SSHClient } from "ssh2";
import { NeovimClient } from "neovim";

import { Emit } from "main/emit";
import { Setting } from "main/setting";
import { Workspace } from "main/envim/workspace";

export class Connection {
  private static workspaces = new Map<string, Workspace>();
  private static current?: Workspace;

  private static attach(reader: Readable, writer: Writable, bookmark: string) {
    const nvim = new NeovimClient;

    nvim.attach({ reader, writer });
    nvim.setClientInfo("Envim", { major: 0, minor: 0, patch: 1, prerelease: "dev" }, "ui", {}, {});
    nvim.on("disconnect", () => Connection.disconnect(bookmark));
    nvim.channelId.then(id => nvim.setVar("envim_id", id));

    return nvim;
  }

  private static command(command: string, bookmark: string, callback: (nvim: NeovimClient) => void) {
    try {
      const { stdout, stdin } = spawn(command || "nvim", ["--embed"]);

      callback(Connection.attach(stdout, stdin, bookmark));
    } catch (e) {
      Connection.error("command", bookmark);
    }
  }

  private static network(address: string, bookmark: string, callback: (nvim: NeovimClient) => void) {
    try {
      const [port, host] = address.split(":").reverse();
      const socket = createConnection({ port: +port, host });

      socket.setNoDelay();
      callback(Connection.attach(socket, socket, bookmark));
    } catch (e) {
      Connection.error("network", bookmark);
    }
  }

  private static docker(id: string, bookmark: string, callback: (nvim: NeovimClient) => void) {
    const docker = new Docker;
    const container = docker.getContainer(id);

    container.inspect(async (err, info) => {
      if (err) return Connection.error("docker", bookmark);

      info?.State.Running || (await container.start());

      container.exec({ Cmd: ["nvim", "--embed"], AttachStdin: true, AttachStdout: true }, (e, exec) => {
        if (e) return Connection.error("docker", bookmark);
        if (!exec) return Connection.error("docker", bookmark);

        exec.start({ hijack: true, stdin: true, Tty: true }, (e, stream) => {
          if (e) return Connection.error("docker", bookmark);
          if (!stream) return Connection.error("docker", bookmark);

          callback(Connection.attach(stream, stream, bookmark));
        });
      });
    });
  }

  private static ssh(uri: string, bookmark: string, callback: (nvim: NeovimClient) => void) {
    const { protocol, hostname, port, username, password, searchParams } = new URL(uri);
    const ssh = new SSHClient;

    protocol === "ssh:" && ssh
      .on("ready", () => {
        ssh.exec("nvim --embed", {}, (e, stream) => {
          if (e) return Connection.error("ssh", bookmark);

          callback(Connection.attach(stream, stream, bookmark));
          stream.on("exit", ssh.end);
        });
      })
      .on("error", () => Connection.error("ssh", bookmark))
      .connect({
        host: hostname,
        port: +(port || 22),
        username,
        password,
        privateKey: searchParams.has("key") ? readFileSync(searchParams.get("key") || "") : "",
        passphrase: searchParams.get("pass") || "",
        readyTimeout: 5000,
      });
  }

  static error(type: string, bookmark: string) {
    const setting = Setting.get();
    const message = `Connection error occurred : "[${type}]:${bookmark}".\nDelete preset?`;

    if (!setting?.presets[`[${type}]:${bookmark}`]) return;
    if (Electron.dialog.showMessageBoxSync({ message, buttons: ["Yes", "No"], defaultId: 0 }) === 0) {
      Setting.remove(type, bookmark);
      Emit.share("envim:init");
    }
  }

  static connect(type: string, path: string, bookmark: string) {
    const next = Connection.workspaces.get(bookmark);
    const attach = (nvim: NeovimClient) => {
      const workspace = next || new Workspace(nvim, bookmark);

      Connection.current = workspace;
      Connection.workspaces.set(bookmark, workspace);
      Connection.emitWorkspace();
      Emit.share("envim:native:theme");
    };

    if (next) return attach(next.nvim);

    switch (type) {
      case "command": return Connection.command(path, bookmark, attach);
      case "address": return Connection.network(path, bookmark, attach);
      case "docker": return Connection.docker(path, bookmark, attach);
      case "ssh": return Connection.ssh(path, bookmark, attach);
    }
  }

  static disconnect(bookmark: string) {
    const workspace = Connection.workspaces.get(bookmark);

    workspace && workspace.dispose();

    Connection.workspaces.delete(bookmark);
    Connection.current = Connection.current === workspace ? [ ...Connection.workspaces.values() ][0] : Connection.current;
    Connection.emitWorkspace();
  }

  private static async emitWorkspace() {
    const state: { [key: string]: boolean } = {};

    Connection.workspaces.forEach((workspace, key) => {
      state[key] = workspace === Connection.current;
    });

    Emit.update("app:workspace", false, state);
    Connection.current?.bookmark && await Connection.current.nvim.command(`cd ${Connection.current.bookmark}`);
  }

  static active() {
    return Connection.current;
  }
}
