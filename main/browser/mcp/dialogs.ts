import type * as Electron from "electron";

const MAX_MESSAGE = 2000;
const RUN_DIALOG = "-run-dialog";
const CANCEL_DIALOGS = "-cancel-dialogs";

type DialogType = "alert" | "confirm" | "prompt";
type Respond = (accept: boolean, text: string) => void;
type Listener = (info: DialogInfo, callback: Respond) => void;

interface DialogInfo {
  dialogType: DialogType;
  messageText: string;
}

export interface PageDialog {
  type: DialogType;
  message: string;
}

export interface DialogOwner {
  owns: () => boolean;
  onHold: (dialog: PageDialog) => void;
}

interface HeldDialog extends PageDialog {
  info: DialogInfo;
  respond: Respond;
  answering?: boolean;
}

interface GuestDialogs {
  guest: Electron.WebContents;
  native: Listener[];
  owner?: DialogOwner;
  notes: string[];
  onHold?: (dialog: PageDialog) => void;
  held?: HeldDialog;
  shown?: PageDialog;
}

export type ActionOutcome = { value: unknown; notes: string[] } | { dialog: PageDialog; notes: string[] };

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

export class Dialogs {
  private static readonly guests = new Map<number, GuestDialogs>();

  static track(guest: Electron.WebContents): void {
    const emitter = guest as unknown as NodeJS.EventEmitter;
    const native = emitter.listeners(RUN_DIALOG) as Listener[];
    if (native.length === 0) return;

    const id = guest.id;
    const state: GuestDialogs = { guest, native, notes: [] };
    Dialogs.guests.set(id, state);
    emitter.removeAllListeners(RUN_DIALOG);
    emitter.on(RUN_DIALOG, (info: DialogInfo, callback: Respond) => Dialogs.onDialog(state, info, callback));
    emitter.on(CANCEL_DIALOGS, () => Dialogs.onCancel(state));
    guest.once("destroyed", () => {
      Dialogs.onCancel(state);
      Dialogs.guests.delete(id);
    });
  }

  static claim(guest: Electron.WebContents, owner: DialogOwner): void {
    const state = Dialogs.guests.get(guest.id);
    if (state) state.owner = owner;
  }

  private static holds(state: GuestDialogs): boolean {
    return !state.held && !!state.owner?.owns();
  }

  private static onDialog(state: GuestDialogs, info: DialogInfo, callback: Respond): void {
    const dialog: PageDialog = { type: info.dialogType, message: clip(String(info.messageText ?? "")) };
    if (!Dialogs.holds(state) || dialog.type === "prompt") return Dialogs.show(state, info, callback, dialog);

    if (dialog.type === "alert") {
      callback(true, "");
      state.notes.push(`The page showed an alert: ${JSON.stringify(dialog.message)}.`);
      return;
    }

    let answered = false;
    state.held = { ...dialog, info, respond: (accept, text) => {
      if (answered) return;

      answered = true;
      callback(accept, text);
    } };
    state.owner?.onHold(dialog);
    state.onHold?.(dialog);
  }

  private static show(state: GuestDialogs, info: DialogInfo, callback: Respond, dialog: PageDialog): void {
    state.shown = dialog;
    const done: Respond = (accept, text) => {
      if (state.shown === dialog) state.shown = undefined;
      callback(accept, text);
    };
    for (const listener of state.native) listener.call(state.guest, info, done);
  }

  private static onCancel(state: GuestDialogs): void {
    state.shown = undefined;
    state.held = undefined;
  }

  static leaveForAgent(guest: Electron.WebContents): boolean {
    const state = Dialogs.guests.get(guest.id);
    if (!state?.owner?.owns()) return false;

    state.notes.push("The page asked to confirm leaving it, and it was left.");
    return true;
  }

  static assertNone(guest: Electron.WebContents): void {
    const state = Dialogs.guests.get(guest.id);
    if (state?.held) {
      throw new Error(`Tab ${guest.id} is waiting for an answer to ${Dialogs.describe(state.held)}. Answer it with browser_handle_dialog first.`);
    }
    if (state?.shown) {
      throw new Error(`Tab ${guest.id} is showing ${Dialogs.describe(state.shown)} to the user. Wait for the user to answer it.`);
    }
  }

  static willHoldConfirm(guest: Electron.WebContents): boolean {
    const state = Dialogs.guests.get(guest.id);
    return !!state && Dialogs.holds(state);
  }

  static confirmClosed(guest: Electron.WebContents): void {
    const state = Dialogs.guests.get(guest.id);
    if (state) state.held = undefined;
  }

  static describe(dialog: PageDialog): string {
    return `a ${dialog.type} dialog ${JSON.stringify(dialog.message)}`;
  }

  static async act(guest: Electron.WebContents, run: () => Promise<unknown>): Promise<ActionOutcome> {
    const state = Dialogs.guests.get(guest.id);
    if (!state) return { value: await run(), notes: [] };

    Dialogs.assertNone(guest);
    const held = new Promise<PageDialog>(resolve => { state.onHold = resolve; });
    try {
      return await Promise.race([
        Promise.resolve().then(run).then(value => ({ value, notes: state.notes.splice(0) })),
        held.then(dialog => ({ dialog, notes: state.notes.splice(0) })),
      ]);
    } catch (error) {
      const notes = state.notes.splice(0);
      if (error instanceof Error && notes.length > 0) error.message += ` ${notes.join(" ")}`;
      throw error;
    } finally {
      state.onHold = undefined;
    }
  }

  private static public({ type, message }: PageDialog): PageDialog {
    return { type, message };
  }

  static async answer(
    guest: Electron.WebContents, accept: unknown, delegate?: (accept: boolean) => Promise<boolean>,
  ): Promise<PageDialog | undefined> {
    if (typeof accept !== "boolean") throw new Error("Accept must be a boolean.");

    const state = Dialogs.guests.get(guest.id);
    const held = state?.held;
    if (!state || !held) {
      const shown = state?.shown ? ` It is showing ${Dialogs.describe(state.shown)} to the user, who answers it.` : "";
      throw new Error(`Tab ${guest.id} has no dialog waiting for your answer.${shown}`);
    }
    if (held.answering) throw new Error("An answer is already in progress.");
    held.answering = true;
    try {
      const delegated = delegate ? await delegate(accept) : false;
      if (state.held === held) {
        state.held = undefined;
        if (!delegated) held.respond(accept, "");
      } else if (!delegated) {
        throw new Error("The dialog is no longer waiting for your answer.");
      }
    } finally {
      held.answering = false;
    }
    return state.held && Dialogs.public(state.held);
  }

  static release(guestId: number): void {
    const state = Dialogs.guests.get(guestId);
    if (!state) return;

    state.notes = [];
    const held = state.held;
    if (!held || state.guest.isDestroyed()) return;

    state.held = undefined;
    Dialogs.show(state, held.info, held.respond, Dialogs.public(held));
  }
}
