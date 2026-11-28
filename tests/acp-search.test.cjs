const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

// Exercise the search effect without loading Electron or the rest of the panel.
const source = fs.readFileSync('renderer/components/acp/index.tsx', 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AcpComponent');
const effect = component.body.statements.filter(ts.isExpressionStatement).map(node => node.expression)
  .find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useEffect'
    && node.arguments[0].getText(ast).includes('CSS.highlights'));
const implementation = new Module(__filename);
implementation._compile(ts.transpileModule(`
  exports.run = (state, scroll, setState, document, NodeFilter, Range, getComputedStyle, CSS, Highlight) => (${effect.arguments[0].getText(ast)})();
  exports.dependencies = state => (${effect.arguments[1].getText(ast)});
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, __filename);

function setup(markup) {
  const dom = new JSDOM(`<div id="list">${markup}<div id="end"></div></div>`);
  const document = dom.window.document;
  const highlights = new Map(), moves = [], animations = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { moves.push({ target: this, options }); };
  dom.window.HTMLElement.prototype.animate = function (frames, options) { animations.push({ target: this, frames, options }); };
  let state = { search: { query: '', active: 0, highlight: false, ranges: [] } };
  let previousDependencies;
  const render = () => {
    let dependencies = implementation.exports.dependencies(state);
    while (!previousDependencies || dependencies.some((value, i) => value !== previousDependencies[i])) {
      previousDependencies = dependencies;
      implementation.exports.run(state, { current: document.querySelector('#end') }, update => { state = update(state); },
        document, dom.window.NodeFilter, dom.window.Range, element => dom.window.getComputedStyle(element),
        { highlights }, class { constructor(...ranges) { this.ranges = ranges; } });
      dependencies = implementation.exports.dependencies(state);
    }
  };
  return {
    document, highlights, moves, animations, render,
    get result() { return state.search; },
    search(update) { state = { search: { ...state.search, ...update } }; render(); },
    close: () => dom.window.close()
  };
}

test('scrolls and softly emphasizes the paragraph containing a match, preserving text highlights', () => {
  const app = setup('<p>long\ntext\nwith <strong>match</strong> here</p>');
  app.search({ query: 'match', highlight: true });
  const paragraph = app.document.querySelector('p');
  assert.deepEqual(app.moves, [{ target: paragraph, options: { behavior: 'smooth', block: 'nearest', inline: 'nearest' } }]);
  assert.equal(app.animations[0].target, paragraph);
  assert.equal(app.animations[0].frames[0].backgroundColor, 'var(--mantine-color-orange-light)');
  assert.equal(app.animations[0].options.duration, 1200);
  assert.equal(app.highlights.get('search-all').ranges[0].toString(), 'match');
  assert.deepEqual(app.highlights.get('search-active').ranges, [app.result.ranges[0]]);
  app.close();
});

test('searches tool content only while it is mounted', () => {
  const app = setup('<button>Tool</button><div id="tool"></div>');
  const tool = app.document.querySelector('#tool');
  app.search({ query: 'match', highlight: true });
  assert.equal(app.result.ranges.length, 0);

  tool.innerHTML = '<pre><code>long\n<span>match</span>\ncode</code></pre>';
  app.search({ active: 1 });
  assert.equal(app.result.ranges.length, 1);
  assert.equal(app.moves.at(-1).target, tool.querySelector('pre'));

  tool.replaceChildren();
  app.search({ active: 1 });
  assert.equal(app.result.ranges.length, 0);
  assert.equal(app.highlights.size, 0);
  app.close();
});

test('message updates do not re-search or scroll; index changes search the latest content', () => {
  const app = setup('<p>match</p>');
  app.search({ query: 'match', highlight: true });
  const snapshot = app.result.ranges;
  app.document.querySelector('p').textContent = 'match match';
  app.render();
  assert.equal(app.result.ranges, snapshot);
  assert.equal(app.highlights.get('search-all').ranges.length, 1);
  assert.equal(app.moves.length, 1);
  app.search({ active: 1 });
  assert.equal(app.result.ranges.length, 2);
  assert.equal(app.result.active, 1);
  assert.equal(app.highlights.get('search-all').ranges.length, 2);
  assert.equal(app.moves.length, 2);
  app.search({ active: -1 });
  assert.equal(app.result.active, 1);
  app.search({ highlight: false });
  assert.equal(app.highlights.size, 0);
  app.close();
});

test('no results clear highlights and do not scroll or animate', () => {
  const app = setup('<p>match</p>');
  app.search({ query: 'match', highlight: true });
  app.search({ query: 'absent' });
  assert.equal(app.result.ranges.length, 0);
  assert.equal(app.highlights.size, 0);
  assert.equal(app.moves.length, 1);
  assert.equal(app.animations.length, 1);
  app.document.querySelector('p').textContent = 'absent absent';
  app.render();
  assert.equal(app.result.ranges.length, 0);
  app.search({ active: 1 });
  assert.equal(app.result.ranges.length, 2);
  assert.equal(app.result.active, 1);
  app.close();
});
