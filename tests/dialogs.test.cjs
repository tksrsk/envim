const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

function loadModule(file, overrides = {}, cache = new Map()) {
  const filename = path.resolve(__dirname, '..', file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename);
  cache.set(filename, loaded);
  loaded.require = name => {
    if (name in overrides) return overrides[name];
    if (/^(main|common)\//.test(name)) return loadModule(name + '.ts', overrides, cache);
    return require(name);
  };
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  return loaded.exports;
}

let nextId = 100;

// A guest with Electron's internal dialog listener, which records the dialogs shown to the user.
function createGuest() {
  const guest = Object.assign(new EventEmitter(), {
    id: nextId++,
    shown: [],
    destroyed: false,
    isDestroyed() { return this.destroyed; },
  });
  guest.on('-run-dialog', (info, callback) => guest.shown.push({ info, callback }));
  return guest;
}

function openDialog(guest, dialogType, messageText) {
  return new Promise(resolve => {
    guest.emit('-run-dialog', { dialogType, messageText }, (accept, text) => resolve({ accept, text }));
  });
}

// One module cache, so BrowserTools and the tests share the Dialogs state.
const cache = new Map();
const overrides = {
  electron: { webContents: { fromId: id => guests.get(id) } },
  'main/browser/mcp/playwright': { PlaywrightWorkspace: class {
    async sync([guest]) { this.selected = guest; }
    callTool() { return openDialog(this.selected, 'confirm', 'Delete the item?'); }
    async answerDialog() { return false; }
    remove() {}
    close() {}
  } },
  'main/mcp/picker': { pickElement: async () => {}, stopPicking: () => {}, isPicking: () => false },
};
const guests = new Map();
const { Dialogs } = loadModule('main/browser/mcp/dialogs.ts', overrides, cache);
const { BrowserTools } = loadModule('main/browser/mcp/tools.ts', overrides, cache);

// A tracked guest whose dialogs go to the agent while owner.owned is true.
function ownedGuest() {
  const guest = createGuest();
  const owner = { owned: true, held: [] };
  Dialogs.track(guest);
  Dialogs.claim(guest, { owns: () => owner.owned, onHold: dialog => owner.held.push(dialog) });
  return { guest, owner };
}

test('dialogs of a tab the agent does not own are shown to the user and block agent actions until answered', async () => {
  const { guest, owner } = ownedGuest();
  owner.owned = false;

  const closed = openDialog(guest, 'confirm', 'Delete?');
  assert.equal(guest.shown.length, 1);
  assert.throws(() => Dialogs.assertNone(guest), /showing a confirm dialog "Delete\?" to the user/);
  await assert.rejects(Dialogs.answer(guest, true), /no dialog waiting for your answer/);
  assert.equal(Dialogs.leaveForAgent(guest), false);

  guest.shown[0].callback(false, '');
  assert.deepEqual(await closed, { accept: false, text: '' });
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
});

test('agent actions close alerts, hold confirms for the agent and continue after the answer', async () => {
  const { guest, owner } = ownedGuest();

  let finish;
  const outcome = await Dialogs.act(guest, async () => {
    assert.deepEqual(await openDialog(guest, 'alert', 'Saved'), { accept: true, text: '' });
    const answer = await openDialog(guest, 'confirm', 'Leave?');
    await new Promise(resolve => { finish = resolve; });
    return answer.accept ? 'left' : 'stayed';
  });
  assert.deepEqual(outcome, {
    dialog: { type: 'confirm', message: 'Leave?' },
    notes: ['The page showed an alert: "Saved".'],
  });
  assert.equal(guest.shown.length, 0);
  assert.deepEqual(owner.held, [{ type: 'confirm', message: 'Leave?' }]);
  assert.throws(() => Dialogs.assertNone(guest), /waiting for an answer to a confirm dialog "Leave\?"/);
  await assert.rejects(Dialogs.act(guest, async () => 'other'), /browser_handle_dialog/);
  await assert.rejects(Dialogs.answer(guest, 'yes'), /Accept must be a boolean/);

  assert.equal(await Dialogs.answer(guest, true), undefined);
  assert.equal(typeof finish, 'function');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
});

test('dialogs opening between actions still go to the agent and the next action reports them', async () => {
  const { guest } = ownedGuest();

  // An alert after an action returns, such as one shown when an Ajax request completes.
  assert.deepEqual(await openDialog(guest, 'alert', 'Updated'), { accept: true, text: '' });
  assert.equal(Dialogs.leaveForAgent(guest), true);
  const closed = openDialog(guest, 'confirm', 'Delete?');
  assert.equal(guest.shown.length, 0);
  assert.throws(() => Dialogs.assertNone(guest), /waiting for an answer to a confirm dialog "Delete\?"/);

  assert.equal(await Dialogs.answer(guest, false), undefined);
  assert.deepEqual(await closed, { accept: false, text: '' });
  assert.deepEqual(await Dialogs.act(guest, async () => 'next'), { value: 'next', notes: [
    'The page showed an alert: "Updated".', 'The page asked to confirm leaving it, and it was left.',
  ] });
  assert.deepEqual(await Dialogs.act(guest, async () => 'again'), { value: 'again', notes: [] });
});

test('prompts are left to Electron even during agent actions', async () => {
  const { guest } = ownedGuest();

  let closed;
  const outcome = await Dialogs.act(guest, async () => {
    closed = openDialog(guest, 'prompt', 'Name?');
    return 'done';
  });
  assert.deepEqual(outcome, { value: 'done', notes: [] });
  assert.equal(guest.shown.length, 1);
  guest.shown[0].callback(false, '');
  assert.deepEqual(await closed, { accept: false, text: '' });
});

test('a released dialog goes to the user with the notes dropped, and a cancelled one is gone', async () => {
  const { guest, owner } = ownedGuest();

  await openDialog(guest, 'alert', 'Stale');
  const closed = openDialog(guest, 'confirm', 'Pay?');
  owner.owned = false;
  Dialogs.release(guest.id);
  assert.equal(guest.shown.length, 1);
  assert.equal(guest.shown[0].info.messageText, 'Pay?');
  assert.throws(() => Dialogs.assertNone(guest), /to the user/);
  guest.shown[0].callback(true, '');
  assert.deepEqual(await closed, { accept: true, text: '' });

  owner.owned = true;
  assert.deepEqual(await Dialogs.act(guest, async () => 'fresh'), { value: 'fresh', notes: [] });
  await Dialogs.act(guest, () => openDialog(guest, 'confirm', 'Again?').then(() => new Promise(() => {})));
  guest.emit('-cancel-dialogs', { resetState: false });
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
});

test('a delegated answer keeps a second confirm for the agent', async () => {
  const { guest } = ownedGuest();

  const result = await Dialogs.act(guest, async () => {
    void openDialog(guest, 'confirm', 'First?');
    return 'original result';
  });
  assert.equal(result.dialog.message, 'First?');

  let closed;
  const next = await Dialogs.answer(guest, true, async () => {
    Dialogs.confirmClosed(guest);
    closed = openDialog(guest, 'confirm', 'Second?');
    return true;
  });
  assert.equal(next.message, 'Second?');
  assert.equal(guest.shown.length, 0);

  const finished = await Dialogs.answer(guest, false);
  assert.deepEqual(await closed, { accept: false, text: '' });
  assert.equal(finished, undefined);
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
});

test('guests without Electron\'s dialog listener are left alone', async () => {
  const guest = Object.assign(new EventEmitter(), { id: nextId++, isDestroyed: () => false });
  Dialogs.track(guest);
  assert.equal(guest.listenerCount('-run-dialog'), 0);
  assert.deepEqual(await Dialogs.act(guest, async () => 'done'), { value: 'done', notes: [] });
});

test('browser_click reports a dialog and browser_handle_dialog responds', async () => {
  const guest = createGuest();
  Object.assign(guest, {
    session: new EventEmitter(),
    getType: () => 'webview',
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: async () => ({ ok: true, value: false }),
  });
  const notices = [];
  guests.set(guest.id, guest);
  Dialogs.track(guest);
  const listeners = new Map();
  loadModule('main/browser/mcp/sharedbrowser.ts', overrides, cache).registerBrowserOwner(guest, 'workspace');
  const service = new BrowserTools({ id: 'workspace', browserTabs: { setShared() {} }, emit: {
    on: (channel, listener) => listeners.set(channel, listener),
    send() {},
    update: (event, _async, notice) => notices.push([event, notice]),
  } }, async () => 'http://127.0.0.1:1');
  const handlers = {};
  service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } });
  const call = (name, args) => handlers['tools/call']({ params: { name, arguments: args } });
  listeners.get("browser:share:toggle")(guest.id, true);

  const tools = (await handlers['tools/list']()).tools.map(tool => tool.name);
  assert.ok(tools.includes('browser_handle_dialog'));

  const clicked = await call('browser_click', { target: '#delete' });
  assert.equal(clicked.isError, undefined);
  assert.match(clicked.content[0].text, /confirm dialog "Delete the item\?" and waits for an answer/);
  assert.equal(notices.at(-1)[0], 'acp:notice:changed');
  assert.match(notices.at(-1)[1].title, /The agent is answering a confirm dialog .* Stop sharing the tab/);

  const blocked = await call('browser_snapshot', {});
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /browser_handle_dialog first/);

  const answered = await call('browser_handle_dialog', { accept: true });
  assert.equal(answered.isError, undefined);
  assert.equal(answered.content[0].text, 'Pressed OK.');

  const again = await call('browser_handle_dialog', { accept: false });
  assert.equal(again.isError, true);
  service.dispose();
});
