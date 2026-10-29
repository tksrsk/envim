const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../main/envim/grid.ts');
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { Grids } = loaded.exports;

function grid() {
  const grids = new Grids({ highlights: { get: id => ({ fg: Number(id), bg: 0, sp: 0 }) } });
  const grid = grids.get();
  grid.setInfo({ width: 8, height: 1, status: 'show' });
  grid.onReady();
  return grid;
}

// grid_line payloads observed with NVIM v0.13.0-dev-1963+g9290926ccf,
// --clean, ext_linegrid, ordinary redraw (not redraw!).
function line(g, col, cells) {
  let hl = '0';
  for (const cell of cells) {
    if (cell.length > 1) hl = String(cell[1]);
    for (let i = 0; i < (cell[2] || 1); i++) g.setCell(0, col++, cell[0], hl);
  }
}

test('actual wide-glyph update includes the continuation cell', () => {
  const g = grid();
  line(g, 0, [['気', 0], [''], ['a']]);
  assert.equal(g.getCursorPos(0, 0).width, 2);
  g.getFlush();
  line(g, 0, [['天', 0], ['']]);
  assert.equal(g.getCursorPos(0, 0).width, 2);
  assert.equal(g.getFlush().flush[0].cells.find(c => c.col === 0).width, 2);
});

test('actual highlight update includes the continuation even when it is unchanged', () => {
  const g = grid();
  line(g, 0, [['天', 0], [''], ['a']]);
  g.getFlush();
  line(g, 0, [['天', 64], ['']]);
  assert.equal(g.getCursorPos(0, 0).width, 2);
  assert.equal(g.getFlush().flush[0].cells.find(c => c.col === 0).width, 2);
});

test('moving the cursor over a wide glyph preserves its width', () => {
  const g = grid();
  line(g, 0, [['気', 0], [''], ['a']]);
  g.getFlush();
  assert.equal(g.getCursorPos(0, 2).width, 1);
  assert.equal(g.getCursorPos(0, 0).width, 2);
});
