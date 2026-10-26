const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');

async function setup(t) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.CSS = { highlights: new Map() };
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const handlers = new Map();
  const emit = {
    on: (event, handler) => handlers.set(event, handler),
    off: event => handlers.delete(event),
    send() {}, share() {}
  };
  const cache = new Map();
  function load(name) {
    if (name === 'renderer/context/workspace') return { useWorkspace: () => ({ emit }) };
    if (name === 'renderer/utils/setting') return { Setting: { acp: { customs: [], mcpServers: [] }, font: { size: 16 } } };
    if (name === 'renderer/components/acp/app') return { McpAppsComponent: () => null };
    if (!name.startsWith('renderer/')) return require(name);
    if (cache.has(name)) return cache.get(name).exports;
    const base = path.resolve(__dirname, '..', name);
    const filename = ['.tsx', '.ts'].map(ext => base + ext).find(file => fs.existsSync(file));
    const loaded = new Module(filename);
    cache.set(name, loaded);
    loaded.require = load;
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true }
    }).outputText, filename);
    return loaded.exports;
  }
  const { AcpComponent } = load('renderer/components/acp/index');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(AcpComponent)));
  async function receive(event, ...args) {
    await React.act(async () => handlers.get(event)(...args));
  }
  await receive('acp:status:changed', { status: 'connected', sessionId: 'active' });
  t.after(async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const key of ['window', 'document', 'HTMLElement', 'CSS', 'IS_REACT_ACT_ENVIRONMENT']) delete global[key];
  });
  return {
    container,
    receive,
    notice: notice => receive('acp:status:changed', { status: 'connected', sessionId: 'active', notice }),
    message: (update, sessionId = 'active') => receive('acp:message:added', { sessionId, update }),
    get compactions() { return [...container.querySelectorAll('details')].filter(element => element.querySelector('summary')?.textContent.includes('context') || element.querySelector('summary')?.textContent.includes('Context')); }
  };
}
const progress = (fields = {}) => ({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'in_progress', ...fields });
const chunk = text => ({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'a', content: { type: 'text', text } });

test('notices render severity and plain text without interpreting HTML', async t => {
  const ui = await setup(t);
  for (const [severity, color] of [['info', 'blue'], ['warning', 'yellow'], ['error', 'red'], ['future', 'blue']]) {
    await ui.notice({ severity, title: severity, description: '<script>example</script>' });
    const title = [...ui.container.querySelectorAll('strong')].find(node => node.textContent === severity);
    assert.ok(title.closest(`[class~="color-${color}"]`));
    assert.ok(title.closest('[role]').textContent.includes('<script>example</script>'));
  }
  assert.equal(ui.container.querySelector('script'), null);
});

test('compaction updates the original row independently of the notice area', async t => {
  const ui = await setup(t);
  await ui.message(progress({ summary: [{ type: 'text', text: 'Summary' }] }));
  const row = ui.compactions[0];
  assert.match(row.textContent, /Compacting context/);
  assert.ok(row.querySelector('.loading'));
  await ui.notice({ severity: 'info', title: 'Working' });
  await ui.message(progress({ status: 'completed' }));
  assert.equal(ui.compactions.length, 1);
  assert.equal(ui.compactions[0], row);
  assert.match(row.textContent, /Context compacted/);
  assert.match(row.textContent, /Summary/);
  assert.equal(row.querySelector('.loading'), null);
  const notice = ui.container.querySelector('strong');
  assert.ok(row.compareDocumentPosition(notice) & window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('summary chunks create a row, append, and preserve completion', async t => {
  const ui = await setup(t);
  await ui.message(chunk('First'));
  assert.match(ui.compactions[0].textContent, /Compacting context/);
  await ui.message(progress({ status: 'completed' }));
  await ui.message(chunk('Second'));
  assert.equal(ui.compactions.length, 1);
  assert.match(ui.compactions[0].textContent, /Context compacted.*First.*Second/s);
});

test('replacement and cleared summaries and errors are reflected in the display', async t => {
  const ui = await setup(t);
  await ui.message(progress({ status: 'failed', summary: [{ type: 'text', text: 'Old summary' }], error: 'Failure details' }));
  assert.match(ui.compactions[0].textContent, /Context compaction failed.*Failure details.*Old summary/s);
  assert.equal(ui.container.querySelector('[role="alert"]'), null);
  await ui.message(progress({ summary: [{ type: 'text', text: 'New summary' }], error: null }));
  assert.doesNotMatch(ui.compactions[0].textContent, /Failure details|Old summary/);
  assert.match(ui.compactions[0].textContent, /New summary/);
  await ui.message(progress({ summary: [] }));
  assert.doesNotMatch(ui.compactions[0].textContent, /New summary/);
  await ui.message(chunk('Temporary'));
  await ui.message(progress({ status: 'cancelled', summary: null }));
  assert.doesNotMatch(ui.compactions[0].textContent, /Temporary/);
  assert.match(ui.compactions[0].textContent, /Context compaction cancelled/);
});

test('matching compaction IDs in another session do not overwrite the active display', async t => {
  const ui = await setup(t);
  await ui.message(progress());
  await ui.message(progress({ status: 'cancelled' }), 'other');
  await ui.message(progress({ compactionId: 'b', status: 'completed' }));
  assert.equal(ui.compactions.length, 2);
  assert.match(ui.compactions[0].textContent, /Compacting context/);
  await ui.receive('acp:status:changed', { status: 'connected', sessionId: 'other' });
  assert.equal(ui.compactions.length, 1);
  assert.match(ui.compactions[0].textContent, /Context compaction cancelled/);
});


test('the notice area replaces the previous notice and clears with status', async t => {
  const ui = await setup(t);
  await ui.notice({ severity: 'error', title: 'Previous error', description: 'Old detail' });
  await ui.notice({ severity: 'warning', title: 'Latest warning' });
  assert.doesNotMatch(ui.container.textContent, /Previous error|Old detail/);
  assert.equal(ui.container.querySelectorAll('strong').length, 1);
  assert.equal(ui.container.querySelector('strong').textContent, 'Latest warning');
  await ui.receive('acp:status:changed', { status: 'connected', sessionId: 'active' });
  assert.equal(ui.container.querySelector('strong'), null);
});

test('notice area is available without a session during startup and authentication', async t => {
  const ui = await setup(t);
  for (const status of ['connecting', 'authenticating', 'disconnected']) {
    await ui.receive('acp:status:changed', { status, notice: { severity: 'error', title: 'Startup failed' } });
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /Startup failed/);
  }
});

test('compaction errors remain in the compaction UI when notices change or clear', async t => {
  const ui = await setup(t);
  await ui.message(progress({ status: 'failed', error: 'Compaction failure' }));
  await ui.notice({ severity: 'warning', title: 'Independent notice' });
  assert.match(ui.compactions[0].textContent, /Compaction failure/);
  assert.doesNotMatch(ui.compactions[0].textContent, /Independent notice/);
  await ui.receive('acp:status:changed', { status: 'connected', sessionId: 'active' });
  assert.match(ui.compactions[0].textContent, /Compaction failure/);
  assert.doesNotMatch(ui.container.textContent, /Independent notice/);
});
