import { readFileSync } from "fs";
import { Readable, Writable } from "stream";
import { spawn } from "child_process";
import { createConnection } from "net";
import Docker from "dockerode";
import { Client as SSHClient } from "ssh2";
import { NeovimClient } from "neovim";

export class Connection {
  private static workspaces: { nvim: NeovimClient; bookmark: string, key: string }[] = [];
  private static current?: { nvim: NeovimClient; bookmark: string, key: string };
  private static timer: number = 0;

  private static attach(reader: Readable, writer: Writable) {
    const nvim = new NeovimClient;

    nvim.attach({ reader, writer });
    return nvim;
  }

  private static command(command: string, callback: (nvim: NeovimClient) => void, error: () => void) {
    try {
      const { stdout, stdin } = spawn(command || "nvim", ["--embed"]);

      callback(Connection.attach(stdout, stdin));
    } catch (e) {
      error();
    }
  }

  private static network(address: string, callback: (nvim: NeovimClient) => void, error: () => void) {
    try {
      const [port, host] = address.split(":").reverse();
      const socket = createConnection({ port: +port, host: host });

      socket.setNoDelay();
      callback(Connection.attach(socket, socket));
    } catch (e) {
      error();
    }
  }

  private static docker(id: string, callback: (nvim: NeovimClient) => void, error: () => void) {
    const docker = new Docker;
    const container = docker.getContainer(id);

    container.inspect(async (err, info) => {
      if (err) return error();

      info?.State.Running || (await container.start());

      container.exec({ Cmd: ["nvim", "--embed"], AttachStdin: true, AttachStdout: true }, (e, exec) => {
        if (e) return error();
        if (!exec) return error();

        exec.start({ hijack: true, stdin: true, Tty: true }, (e, stream) => {
          if (e) return error();
          if (!stream) return error();

          callback(Connection.attach(stream, stream));
        });
      });
    });
  }

  private static ssh(uri: string, callback: (nvim: NeovimClient) => void, error: () => void) {
    const { protocol, hostname, port, username, password, searchParams } = new URL(uri);
    const ssh = new SSHClient;

    protocol === "ssh:" && ssh
      .on("ready", () => {
        ssh.exec("nvim --embed", {}, (e, stream) => {
          if (e) return error();

          callback(Connection.attach(stream, stream));
          stream.on("exit", ssh.end);
        });
      })
      .on("error", error)
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

  static connect(type: string, path: string, bookmark: string, callback: (nvim: NeovimClient, init: boolean, workspace: string) => void, error: () => void) {
    const next = Connection.workspaces.find(workspace => !workspace.bookmark || workspace.bookmark === bookmark);
    const attach = (nvim: NeovimClient, init: boolean = true) => {
      const workspace = next?.key || { address: path }[type] || `${path}::${bookmark}`;
      const current = Connection.current;

      Connection.current = { nvim, bookmark, key: workspace };
      Connection.workspaces = Connection.workspaces.filter(workspace => workspace.nvim !== nvim);
      Connection.workspaces.push(Connection.current);

      if (next && next === current) return;
      if (current) {
        current.nvim.uiDetach();
        current.nvim.removeAllListeners("request");
        current.nvim.removeAllListeners("notification");
      }

      callback(nvim, init, workspace);
    };

    if (next) return attach(next.nvim, false);

    switch (type) {
      case "command": return Connection.command(path, attach, error);
      case "address": return Connection.network(path, attach, error);
      case "docker": return Connection.docker(path, attach, error);
      case "ssh": return Connection.ssh(path, attach, error);
    }
  }

  static disconnect(workspace: string, callback: (workspace?: { nvim: NeovimClient, bookmark: string, key: string }) => void) {
    Connection.workspaces = Connection.workspaces.filter(({ key }) => workspace !== key);

    clearTimeout(Connection.timer);
    Connection.timer = +setTimeout(() => {
      callback([ ...Connection.workspaces ].pop());
    }, 200);
  }

  static connections() {
    return Connection.workspaces.map(({ bookmark }) => bookmark);
  }
}
