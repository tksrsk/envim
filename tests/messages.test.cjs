const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1000 }));
afterEach(() => mock.timers.reset());
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const path = require('node:path');

function load(file, imports = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const module = new Module(filename);
  module.require = name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  };
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
  }).outputText, filename);
  return module.exports;
}
const { Messages } = load('main/envim/message.ts');
const { App } = load('main/envim/app.ts', { 'main/emit': {} });
const text = items => items.map(m => m.contents.map(c => c.content).join(''));
function setup() {
  const sent = [], handlers = {};
  let state;
  const emit = {
    on: (event, fn) => { handlers[event] = fn; },
    send: (...args) => { sent.push(structuredClone(args)); handlers[args[0]]?.(...args.slice(1)); }
  };
  const react = {
    createElement() {}, useRef: () => ({ current: null }), useEffect: fn => fn(),
    useState: initial => { state = initial; return [initial, fn => { state = fn(state); }]; }
  };
  const { HistoryComponent } = load('renderer/components/envim/history.tsx', {
    react: { __esModule: true, default: react },
    'renderer/context/editor': { useEditor: () => ({ options: {} }) },
    'renderer/context/workspace': { useWorkspace: () => ({ emit }) },
    'renderer/utils/emit': { Emit: {} }, 'renderer/utils/icons': { uiIcons: {} },
    'renderer/components/flex': {}, 'renderer/components/menu': {},
    'renderer/components/icon': {}, 'renderer/components/envim/message': {}
  });
  HistoryComponent({ width: 80, height: 24 });
  const workspace = { emit, nvim: { on() {}, call: async () => [] }, grids: { flush() {} } };
  workspace.messages = new Messages(workspace);
  return { messages: workspace.messages, app: new App(workspace), sent, handlers, get state() { return state; },
    last: suffix => sent.filter(([event]) => event.endsWith(suffix)).at(-1)?.[1] };
}
const show = (m, value, id, replace = false, append = false, history = true) =>
  m.show('echo', [[0, value, 0]], replace, history, append, id, 'typed_cmd');

test('workspace instances isolate notifications and history; IDs and append preserve records', () => {
  const a = setup(), b = setup();
  show(a.messages, 'A', 1); show(a.messages, 'B', 2); show(a.messages, 'C', 2);
  a.messages.flush(); b.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['A', 'C']);
  assert.deepEqual(text(a.state.messages), ['A', 'B', 'C']);
  assert.equal(b.last(':show'), undefined);
  show(a.messages, 'D', 3, true); show(a.messages, ' \nE', 4, false, true);
  a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['A', 'D \nE']);
  a.messages.clear(); a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
  assert.deepEqual(text(a.state.messages), ['A', 'B', 'C', 'D \nE']);
  assert.equal(a.handlers['neovim:ui:messages:history:clear'], undefined);
  assert.equal(a.handlers['neovim:ui:messages:record'], undefined);
});

test('App delegates notifications and history replacement', () => {
  const a = setup();
  const event = (kind, value, id) => ['msg_show', [kind, [[0, value, 0]], false, kind !== 'empty', false, id, '']];
  a.app.onNotification('redraw', [event('echo', 'same', 1), event('echo', 'same', 2)]);
  a.app.onNotification('redraw', [event('empty', '', 3), ['flush', []]]);
  assert.deepEqual(text(a.last(':show')), ['same', 'same']);
  a.app.onNotification('redraw', [event('empty', '', 4), ['flush', []]]);
  assert.deepEqual(a.last(':show'), []);
  a.app.onNotification('redraw', [['msg_history_show', [[['echo', [[0, 'A', 0]], false], ['echo', [[0, 'B', 0]], true]], false]]]);
  assert.deepEqual(text(a.last(':history')), ['AB']);
  a.app.onNotification('redraw', [['msg_history_show', [[], true]]]);
  assert.deepEqual(a.sent.at(-1), ['neovim:ui:messages:history', [], true]);
  assert.deepEqual(a.state.messages, []);
});

test('history excludes transient messages and retains the latest 1000 records', () => {
  const a = setup();
  for (let i = 0; i < 1005; i++) show(a.messages, String(i), i);
  show(a.messages, 'transient', 'status', false, false, false);
  a.messages.flush();
  assert.equal(a.state.messages.length, 1000);
  assert.equal(text(a.state.messages)[0], '5');
  assert.equal(text(a.state.messages).at(-1), '1004');
});

test('history replacements overwrite the list and subsequent additions append without duplication', () => {
  const a = setup();
  show(a.messages, 'local', 1);
  a.messages.showHistory([['echo', [[0, 'old', 0]], false]]);
  a.messages.showHistory([['echo', [[0, 'old', 0]], false]]);
  show(a.messages, 'new', 2);
  assert.deepEqual(text(a.state.messages), ['old', 'new']);
  a.messages.showHistory([]);
  assert.deepEqual(a.state.messages, []);
  assert.deepEqual(a.sent.filter(([name]) => name.endsWith(':history')).map(args => args[2]), [false, true, true, false, true]);
});

test('notifications expire only on the next flush, retaining history', () => {
  const a = setup();
  show(a.messages, 'old', 1); a.messages.flush();
  mock.timers.tick(999);
  assert.deepEqual(text(a.last(':show')), ['old']);
  mock.timers.tick(1);
  assert.deepEqual(text(a.last(':show')), ['old']);
  a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
  assert.deepEqual(text(a.state.messages), ['old']);
  show(a.messages, 'new', 2); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['new']);
});

test('updates restart expiry, but unrelated flushes do not', () => {
  const a = setup();
  show(a.messages, 'first', 1); a.messages.flush();
  mock.timers.tick(800);
  show(a.messages, 'updated', 1); a.messages.flush();
  mock.timers.tick(800); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['updated']);
  mock.timers.tick(200);
  a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
});

test('confirm remains on expiry and expired notifications do not absorb new ones', () => {
  const a = setup();
  a.messages.show('confirm', [[0, 'Continue?', 0]], false, false, false, 1, '');
  show(a.messages, 'old', 2); a.messages.flush();
  mock.timers.tick(1000);
  show(a.messages, 'new', 3); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['Continue?', 'new']);
  mock.timers.tick(1000); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['Continue?']);
  a.messages.clear(); a.messages.flush();
  mock.timers.tick(1000); a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
});

test('only a sole empty message clears the batch, regardless of visible count', () => {
  const a = setup();
  const empty = () => a.messages.show('empty', [], false, false, false, 99, '');
  show(a.messages, 'first', 1); show(a.messages, 'updated', 1); empty();
  a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['updated']);
  empty(); empty(); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['updated']);
  empty(); a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
  empty(); show(a.messages, 'next', 2); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['next']);
});

test('empty-kind messages overwrite one slot regardless of incoming IDs and input mode', () => {
  const a = setup();
  show(a.messages, 'notice', 100);
  for (const [id, value] of [[1, ':'], [2, 'e'], [3, ':e'], [4, '/search']]) {
    a.messages.show('', [[0, value, 0]], false, false, false, id, '');
    a.messages.flush();
    assert.deepEqual(text(a.last(':show')), ['notice', value]);
    assert.equal(a.last(':show')[1].id, -1);
  }
  mock.timers.tick(1000); a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
});

test('anonymous history keeps each record even when its notification is overwritten', () => {
  const a = setup();
  a.messages.show('', [[0, 'first', 0]], false, true, false, 1, '');
  a.messages.show('', [[0, 'second', 0]], false, true, false, 2, '');
  a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['second']);
  assert.deepEqual(text(a.state.messages), ['first', 'second']);
});

test('a later notification does not extend an earlier notification lifetime', () => {
  const a = setup();
  show(a.messages, 'first', 1); a.messages.flush();
  mock.timers.tick(800);
  show(a.messages, 'second', 2); a.messages.flush();
  mock.timers.tick(200); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['second']);
  mock.timers.tick(799); a.messages.flush();
  assert.deepEqual(text(a.last(':show')), ['second']);
  mock.timers.tick(1); a.messages.flush();
  assert.deepEqual(a.last(':show'), []);
  assert.deepEqual(text(a.state.messages), ['first', 'second']);
});

test('ID updates and append refresh only the affected notification', () => {
  for (const append of [false, true]) {
    const a = setup();
    show(a.messages, 'first', 1); show(a.messages, 'second', 2); a.messages.flush();
    mock.timers.tick(800);
    show(a.messages, 'updated', append ? 3 : 2, false, append); a.messages.flush();
    mock.timers.tick(200); a.messages.flush();
    assert.deepEqual(text(a.last(':show')), [append ? 'secondupdated' : 'updated']);
    mock.timers.tick(800); a.messages.flush();
    assert.deepEqual(a.last(':show'), []);
  }
});
