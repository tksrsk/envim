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
  'main/mcp/picker': { pickElement: async () => {}, stopPicking: () => {}, isPicking: () => false },
};
const guests = new Map();
const { Dialogs } = loadModule('main/mcp/dialogs.ts', overrides, cache);
const { BrowserTools } = loadModule('main/mcp/browsertools.ts', overrides, cache);

test('dialogs outside agent actions are shown to the user and block agent actions until answered', async () => {
  const guest = createGuest();
  Dialogs.track(guest);

  const closed = openDialog(guest, 'confirm', 'Delete?');
  assert.equal(guest.shown.length, 1);
  assert.throws(() => Dialogs.assertNone(guest), /showing a confirm dialog "Delete\?" to the user/);
  await assert.rejects(Dialogs.answer(guest, true), /no dialog waiting for your answer/);

  guest.shown[0].callback(false, '');
  assert.deepEqual(await closed, { accept: false, text: '' });
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
});

test('agent actions close alerts, hold confirms for the agent and continue after the answer', async () => {
  const guest = createGuest();
  Dialogs.track(guest);

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
  assert.throws(() => Dialogs.assertNone(guest), /waiting for an answer to a confirm dialog "Leave\?"/);
  await assert.rejects(Dialogs.act(guest, async () => 'other'), /handle_dialog/);
  await assert.rejects(Dialogs.answer(guest, 'yes'), /Accept must be a boolean/);

  const answered = Dialogs.answer(guest, true);
  setTimeout(() => finish(), 10);
  assert.deepEqual(await answered, { value: 'left', notes: [] });
  assert.doesNotThrow(() => Dialogs.assertNone(guest));

  // After the action, dialogs go to the user again.
  openDialog(guest, 'alert', 'Later');
  assert.equal(guest.shown.length, 1);
});

test('prompts are left to Electron even during agent actions', async () => {
  const guest = createGuest();
  Dialogs.track(guest);

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

test('a held dialog goes to the user when released, and a cancelled one ends the action', async () => {
  const guest = createGuest();
  Dialogs.track(guest);

  let closed;
  await Dialogs.act(guest, async () => { closed = openDialog(guest, 'confirm', 'Pay?'); return closed; });
  Dialogs.release(guest.id);
  assert.equal(guest.shown.length, 1);
  assert.equal(guest.shown[0].info.messageText, 'Pay?');
  assert.throws(() => Dialogs.assertNone(guest), /to the user/);
  guest.shown[0].callback(true, '');
  assert.deepEqual(await closed, { accept: true, text: '' });

  await Dialogs.act(guest, () => openDialog(guest, 'confirm', 'Again?').then(() => new Promise(() => {})));
  guest.emit('-cancel-dialogs', { resetState: false });
  assert.doesNotThrow(() => Dialogs.assertNone(guest));
  assert.equal(Dialogs.leaveForAgent(guest), false);
  openDialog(guest, 'confirm', 'New page');
  assert.equal(guest.shown.length, 2);
});

test('pages are left without asking only while an agent action runs', async () => {
  const guest = createGuest();
  Dialogs.track(guest);
  assert.equal(Dialogs.leaveForAgent(guest), false);

  const outcome = await Dialogs.act(guest, async () => {
    assert.equal(Dialogs.leaveForAgent(guest), true);
    return 'Went back.';
  });
  assert.deepEqual(outcome, { value: 'Went back.', notes: ['The page asked to confirm leaving it, and it was left.'] });
});

test('guests without Electron\'s dialog listener are left alone', async () => {
  const guest = Object.assign(new EventEmitter(), { id: nextId++, isDestroyed: () => false });
  Dialogs.track(guest);
  assert.equal(guest.listenerCount('-run-dialog'), 0);
  assert.deepEqual(await Dialogs.act(guest, async () => 'done'), { value: 'done', notes: [] });
});

test('use_tab reports a dialog its click opened, and handle_dialog continues the click', async () => {
  const guest = createGuest();
  Object.assign(guest, {
    session: new EventEmitter(),
    getType: () => 'webview',
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isLoadingMainFrame: () => false,
    // The page finds where to click the element.
    executeJavaScriptInIsolatedWorld: async () => ({ ok: true, value: { click: { x: 10, y: 20 } } }),
    debugger: {
      attached: false,
      events: [],
      attach() { this.attached = true; },
      detach() { this.attached = false; },
      isAttached() { return this.attached; },
      // The click handler asks for confirmation, which blocks the page until the dialog closes.
      async sendCommand(method, params) {
        this.events.push([method, params.type, params.x, params.y]);
        if (params.type === 'mouseReleased') await openDialog(guest, 'confirm', 'Delete the item?');
        return {};
      },
    },
  });
  const notices = [];
  guests.set(guest.id, guest);
  Dialogs.track(guest);
  const service = new BrowserTools({ emit: { send: (channel, message) => notices.push([channel, message]) } }, async () => 'http://127.0.0.1:1');
  const handlers = {};
  service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } });
  const call = (name, args) => handlers['tools/call']({ params: { name, arguments: args } });
  service.shareTab(guest.id);

  const tools = (await handlers['tools/list']()).tools.map(tool => tool.name);
  assert.ok(tools.includes('handle_dialog'));

  const clicked = await call('use_tab', { action: 'click', selector: '#delete' });
  assert.equal(clicked.isError, undefined);
  assert.match(clicked.content[0].text, /confirm dialog "Delete the item\?" and waits for an answer/);
  assert.match(notices.at(-1)[1], /The agent is answering a confirm dialog .* Stop sharing the tab/);

  const blocked = await call('use_tab', { action: 'inspect' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /handle_dialog first/);

  assert.deepEqual(guest.debugger.events, [
    ['Input.dispatchMouseEvent', 'mouseMoved', 10, 20],
    ['Input.dispatchMouseEvent', 'mousePressed', 10, 20],
    ['Input.dispatchMouseEvent', 'mouseReleased', 10, 20],
  ]);
  const answered = await call('handle_dialog', { accept: true });
  assert.equal(answered.isError, undefined);
  assert.equal(answered.content[0].text, 'Pressed OK. Clicked the selected element.');

  const again = await call('handle_dialog', { accept: false });
  assert.equal(again.isError, true);
  assert.equal(guest.debugger.isAttached(), false);
  service.reset();
});
