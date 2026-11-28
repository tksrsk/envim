const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

function setup(setting) {
  let saved = {
    type: 'command',
    path: '',
    bookmarks: [
      { name: 'First', path: '/first', selected: false },
      { name: 'Second', path: '/second', selected: false },
    ],
  };
  const notifications = [];
  let saves = 0;
  let workspaceId = 0;
  const imports = {
    electron: {},
    child_process: { spawn: () => ({}) },
    neovim: { NeovimClient: class {
      channelId = Promise.resolve(1);
      attach() {}
      setClientInfo() {}
      setVar() {}
      on() {}
      async command() {}
    } },
    'main/envim/workspace': { Workspace: class {
      id = String(++workspaceId);
      browserTabs = { activate() {} };
      constructor(nvim, bookmark) { Object.assign(this, { nvim, bookmark }); }
      dispose() {}
    } },
    'main/emit': { Emit: {
      send: (...args) => notifications.push(args),
      update: (...args) => notifications.push(args),
      share() {},
    } },
    'main/setting': { Setting: setting ?? {
      get: () => saved,
      set: setting => { saved = setting; saves++; },
    } },
  };
  const filename = path.resolve(__dirname, '../main/connection.ts');
  const loaded = new Module(filename);
  loaded.require = name => imports[name] ?? require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);

  return {
    Connection: loaded.exports.Connection,
    saved: () => saved,
    selected: () => saved.bookmarks.filter(bookmark => bookmark.selected).map(bookmark => bookmark.path),
    saves: () => saves,
    notifications,
  };
}

test('disconnecting the last workspace preserves the saved bookmark', () => {
  const state = setup();
  state.Connection.connect(state.saved(), '/first');
  assert.deepEqual(state.selected(), ['/first']);

  state.Connection.disconnect();

  assert.deepEqual(state.selected(), ['/first']);
  assert.equal(state.saves(), 1);
  assert.deepEqual(state.notifications.slice(-2), [
    ['app:setting', state.saved()],
    ['app:workspace', false, {}, ''],
  ]);
});

test('closing the active workspace does not replace the saved bookmark with the fallback', () => {
  const state = setup();
  state.Connection.connect(state.saved(), '/first');
  state.Connection.connect(state.saved(), '/second');
  assert.deepEqual(state.selected(), ['/second']);

  state.Connection.disconnect();

  assert.deepEqual(state.selected(), ['/second']);
  assert.equal(state.Connection.active().bookmark, '/first');
  state.Connection.disconnect();
  assert.deepEqual(state.selected(), ['/second']);
  assert.equal(state.saves(), 2);
});

test('explicitly connecting to the default workspace clears the previous bookmark selection', () => {
  const state = setup();
  state.Connection.connect(state.saved(), '/first');
  state.Connection.disconnect();
  state.Connection.connect(state.saved(), undefined);

  assert.deepEqual(state.selected(), []);
});
test('the last connected bookmark survives reloading the saved settings file', async t => {
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const appData = await mkdtemp(path.join(tmpdir(), 'envim-settings-'));
  t.after(() => rm(appData, { recursive: true, force: true }));

  function load(file, aliases) {
    const filename = path.resolve(__dirname, '..', file);
    const loaded = new Module(filename);
    loaded.require = name => aliases[name] ?? require(name);
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return loaded.exports;
  }

  const { settingSchema } = load('common/setting.ts', {});
  const aliases = { electron: { app: { getPath: () => appData } }, 'common/setting': { settingSchema } };
  const { Setting } = load('main/setting.ts', aliases);
  const writes = [];
  const { Connection } = setup({
    get: () => Setting.get(),
    set: setting => writes.push(Setting.set(setting)),
  });
  const config = settingSchema.parse({ bookmarks: [
    { name: 'First', path: '/first' },
    { name: 'Second', path: '/second' },
  ] });
  Connection.connect(config, '/first');
  Connection.connect(Setting.get(), '/second');
  Connection.disconnect();
  Connection.disconnect();
  await Promise.all(writes);

  const { Setting: RestartedSetting } = load('main/setting.ts', aliases);
  assert.deepEqual(RestartedSetting.get().bookmarks, [
    { name: 'First', path: '/first', selected: false },
    { name: 'Second', path: '/second', selected: true },
  ]);
});
