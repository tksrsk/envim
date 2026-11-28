const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');

test('reports popup bounds on mount and on resize, and stops observing on hide', () => {
  const dom = new JSDOM('<div id="grid"></div>');
  const grid = dom.window.document.querySelector('#grid');
  const handlers = new Map();
  const calls = [];
  const observers = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(element) { observers.set(this, element); }
      disconnect() { observers.delete(this); }
    },
  };
  const previousGlobals = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);

  const emit = {
    on: (name, callback) => handlers.set(name, callback),
    off: name => handlers.delete(name),
    send: (...args) => calls.push(args),
    share() {},
  };
  const filename = path.resolve(__dirname, '../renderer/components/envim/popupmenu.tsx');
  const loaded = new Module(filename);
  const imports = {
    react: { __esModule: true, default: React },
    'renderer/context/editor': { useEditor: () => ({ options: { ext_popupmenu: true } }) },
    'renderer/context/workspace': { useWorkspace: () => ({ active: true, emit, highlights: { style: () => ({}) } }) },
    'renderer/utils/setting': { Setting: { font: { width: 8 } } },
    'renderer/utils/size': { row2Y: row => row * 16, col2X: col => col * 8 },
  };
  loaded.require = name => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  };

  let width = 84;
  const popupRect = { top: 64, left: 48, height: 32 };
  grid.getBoundingClientRect = () => ({ top: 16, left: 8 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ ...popupRect, width });

  const root = createRoot(grid);
  try {
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText, filename);
    React.act(() => root.render(React.createElement(loaded.exports.PopupmenuComponent)));
    React.act(() => handlers.get('neovim:ui:popupmenu:show')({
      items: ['apple', 'banana', 'cherry'].map(word => ({ word, kind: ' 󰈙 ', menu: ' ' })),
      selected: 0, row: 3, col: 6, height: 2, zIndex: 1,
    }));

    assert.deepEqual(calls, [
      ['neovim:api', 'nvim_ui_pum_set_bounds', [10.5, 2, 3, 5]],
    ]);
    const [[observer, observed]] = observers;
    assert.equal(observed, grid.querySelector('.envim-pum'));
    assert.equal(observed.querySelector('.envim-pum-kind').textContent, '󰈙');

    observer.callback();
    assert.equal(calls.length, 1);
    width = 100;
    observer.callback();
    assert.deepEqual(calls.slice(1), [['neovim:api', 'nvim_ui_pum_set_bounds', [12.5, 2, 3, 5]]]);

    React.act(() => handlers.get('neovim:ui:popupmenu:hide')());
    assert.equal(observers.size, 0);
    assert.equal(grid.querySelector('.envim-pum'), null);
  } finally {
    React.act(() => root.unmount());
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});
