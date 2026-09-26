import type { IMessage } from "common/interface";
import type { Workspace } from "main/envim/workspace";

type Content = [number, string, number][];

export class Messages {
  private visible: (IMessage & { updatedAt: number })[] = [];
  private batch: "none" | "empty" | "other" = "none";
  private dirty = false;

  constructor(private readonly workspace: Workspace) {}

  show(kind: string, content: Content, replaceLast: boolean, history: boolean, append: boolean, id: number | string, _trigger: string) {
    const message = this.convert(kind, content);
    this.batch = this.batch === "none" && kind === "empty" ? "empty" : "other";
    if (kind !== "empty") {
      this.expire();
      if (kind === "") id = -1;
      this.visible = this.merge(this.visible, { ...message, id, updatedAt: Date.now() }, replaceLast, append);
      this.dirty = true;
    }
    if (history) {
      this.workspace.emit.send("neovim:ui:messages:history", [{ ...message, append }], false);
    }
  }

  clear() {
    this.visible = [];
    this.dirty = true;
  }

  showHistory(entries: [string, Content, boolean][]) {
    const messages = entries.reduce<IMessage[]>((messages, [kind, content, append]) =>
      this.merge(messages, this.convert(kind, content), false, append), []);
    this.workspace.emit.send("neovim:ui:messages:history", messages, true);
  }

  status(kind: "mode" | "command" | "ruler", content: Content) {
    this.workspace.emit.update(`neovim:ui:messages:${kind}`, true, this.convert(kind, content));
  }

  flush() {
    if (this.batch === "empty") this.clear();
    this.expire();
    if (this.dirty) {
      this.workspace.emit.send("neovim:ui:messages:show", this.visible.map(({ updatedAt, ...message }) => message));
    }
    this.batch = "none";
    this.dirty = false;
  }

  private expire() {
    const now = Date.now();
    const visible = this.visible.filter(message => message.kind === "confirm" || now - message.updatedAt < 1000);
    if (visible.length !== this.visible.length) {
      this.visible = visible;
      this.dirty = true;
    }
  }

  private convert(kind: string, content: Content): IMessage {
    return { kind, contents: content.map(([hl, content]) => ({ hl: String(hl), content })) };
  }

  private merge<T extends IMessage>(messages: T[], message: T, replaceLast: boolean, append: boolean): T[] {
    const index = message.id === undefined ? -1 : messages.findIndex(item => item.id === message.id);
    if (index >= 0) return messages.map((item, i) => i === index ? message : item);
    const last = messages[messages.length - 1];
    if (append && last) message = { ...message, contents: [...last.contents, ...message.contents] };
    return [...(last && (append || replaceLast) ? messages.slice(0, -1) : messages), message];
  }
}
