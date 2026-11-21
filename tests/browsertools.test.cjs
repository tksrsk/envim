const assert = require('node:assert/strict');
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

function createTab(url) {
  return Object.assign(new (require('node:events').EventEmitter)(), {
    url,
    reloads: 0,
    session: new (require('node:events').EventEmitter)(),
    getType: () => 'webview',
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL() { return this.url; },
    getTitle: () => 'Mock',
    async loadURL(url) { this.url = url; this.reloads++; }
  });
}

function setup({ attachLater = false } = {}) {
  const tabs = [];
  const cache = new Map();
  const overrides = {
    electron: { webContents: { fromId: id => tabs[id], getAllWebContents: () => tabs } },
    'main/mcp/picker': { pickElement: async () => {}, stopPicking: () => {}, isPicking: () => false },
  };
  const { BrowserTools } = loadModule('main/mcp/browsertools.ts', overrides, cache);
  const service = new BrowserTools({
    emit: { send() {} },
    showBrowserTab: async (url, requestId) => {
      const id = tabs.length;
      tabs.push(Object.assign(createTab(url), { id }));
      if (attachLater) setTimeout(() => service.attachSharedTab(requestId, id), 20);
      else service.attachSharedTab(requestId, id);
    }
  }, async () => 'http://127.0.0.1:1');

  function connect() {
    const handlers = {};
    service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } });
    const call = (name, args) => handlers['tools/call']({ params: { name, arguments: args } });
    return Object.assign(html => call('show_mock', { html }), { call });
  }

  return { service, tabs, connect };
}

function loadPicker(window) {
  const source = readFileSync(path.resolve(__dirname, '../main/mcp/picker.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const picker = window.eval('(() => { const exports = {}; const require = () => ({}); ' + js + '; return exports.elementPicker; })()');
  const { pageSelector } = loadModule('main/mcp/page.ts');
  return () => picker(window.eval('(' + pageSelector.toString() + ')'), 'test-picker', false);
}

function loadSharedBrowser(fromId) {
  return loadModule('main/mcp/sharedbrowser.ts', { electron: { webContents: { fromId } } }).SharedBrowser;
}

test('show_mock opens a shared tab on the served page and updates it in place without dropping its fragment', async () => {
  const { service, tabs, connect } = setup();
  const show = connect();
  assert.equal((await show('')).isError, true);
  assert.equal(tabs.length, 0);

  const opened = await show('<button>Settings</button>');
  assert.equal(opened.isError, undefined);
  assert.match(opened.content[0].text, /in new shared tab 0/);
  assert.equal(service.mock.html, '<button>Settings</button>');
  const [tab] = tabs;
  assert.equal(tab.url, 'http://127.0.0.1:1/mock');
  assert.deepEqual(JSON.parse((await show.call('use_tab', { action: 'list' })).content[0].text), [{ tab: 0, url: tab.url, title: 'Mock' }]);

  // Updating reloads the tab at a new revision and keeps the page's state in the fragment.
  tab.url += '#settings=open';
  assert.match((await show('<button>Preferences</button>')).content[0].text, /Updated the mock preview in shared tab 0/);
  assert.equal(tabs.length, 1);
  assert.equal(tab.reloads, 1);
  assert.match(tab.url, /\/mock\?revision=[^#]+#settings=open$/);

  // A tab that is no longer shared is shared again, not duplicated.
  service.revokeTabs();
  assert.deepEqual(JSON.parse((await show.call('use_tab', { action: 'list' })).content[0].text), []);
  await show('<button>Profile</button>');
  assert.equal(tabs.length, 1);
  assert.equal(tab.reloads, 2);
  assert.equal(JSON.parse((await show.call('use_tab', { action: 'list' })).content[0].text).length, 1);

  // A reset forgets the page, so the next agent starts without one.
  service.reset();
  assert.equal(service.mock.html, undefined);
  assert.deepEqual(JSON.parse((await show.call('use_tab', { action: 'list' })).content[0].text), []);
});

test('picker keeps an outline after choosing, supports reselection, and clears on Escape', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button>Open settings</button><button>Close settings</button>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.CSS = { escape: value => value };
  const pick = loadPicker(window);

  try {
    const buttons = window.document.querySelectorAll('button');
    let clicked = false;
    buttons[1].onclick = () => { clicked = true; };
    const result = pick();
    buttons[1].dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    const outline = window.document.documentElement.lastElementChild;
    assert.equal(outline.previousElementSibling.style.display, 'block');
    buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const selected = await result;
    assert.equal(selected.label, 'Close settings');
    assert.equal(window.document.querySelector(selected.selector), buttons[1]);
    assert.equal(clicked, false);
    assert.equal(outline.style.display, 'block');
    const next = window.envimElementPicker.next();
    buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal((await next).label, 'Open settings');
    assert.equal(outline.style.display, 'block');

    const canceled = window.envimElementPicker.next();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    assert.equal(await canceled, null);
    assert.equal(window.document.documentElement.lastElementChild.tagName, 'BODY');
    assert.equal(window.envimElementPicker, undefined);
  } finally {
    window.close();
  }
});

test('type edits the page without a click and reports an unchanged value as an error', async () => {
  const { JSDOM } = require('jsdom');
  const { window } = new JSDOM('<input id="year" type="number" value="2026">', {
    url: 'https://example.test/', runScripts: 'outside-only',
  });
  const { runTabAction } = loadModule('main/mcp/tabs.ts');
  const field = window.document.getElementById('year');
  field.getClientRects = () => [new window.DOMRect(0, 0, 100, 20)];
  field.scrollIntoView = () => {};
  const edits = [];
  window.document.execCommand = (command, _, text) => {
    assert.equal(window.document.activeElement, field);
    edits.push(command);
    if (text === 'ignored') return false;
    field.value = command === 'delete' ? '' : text;
    return true;
  };
  const guest = Object.assign(createTab(window.location.href), {
    executeJavaScriptInIsolatedWorld: (_, [{ code }]) => window.eval(code),
  });
  const tab = { id: 1, guest, scope: window.location.href };
  const type = text => runTabAction(tab, { action: 'type', selector: '#year', text });

  try {
    assert.equal(await type('2025'), 'Entered text in the selected element.');
    assert.equal(field.value, '2025');
    await assert.rejects(type('ignored'), /value did not change/);
    assert.equal(field.value, '2025');
    assert.equal(await type(''), 'Entered text in the selected element.');
    assert.equal(field.value, '');
    assert.deepEqual(edits, ['insertText', 'insertText', 'delete']);
  } finally {
    window.close();
  }
});

test('shares several tabs and targets them by tab id', async () => {
  const { EventEmitter } = require('node:events');
  const urls = new Map([[1, 'https://example.test/already-open'], [2, 'https://example.test/new'], [3, 'https://example.test/other']]);
  const guests = new Map(Array.from(urls.keys(), id => [id, Object.assign(new EventEmitter(), {
    id,
    getType: () => 'webview',
    getURL: () => urls.get(id),
    getTitle: () => 'Tab ' + id,
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    async loadURL(url) { urls.set(id, url); }
  })]));
  const SharedBrowser = loadSharedBrowser(id => guests.get(id));
  const requests = [], statuses = [], revoked = [];
  const shared = new SharedBrowser({ send: (...args) => statuses.push(args) }, guest => revoked.push(guest.id), async (url, id) => {
    requests.push({ url, id });
  });
  const list = () => shared.guests().map(guest => guest.id);

  // With nothing shared, navigate opens a new tab. Two opens can run at the same time.
  const first = shared.navigate('https://example.test/new');
  const second = shared.navigate('https://example.test/other', undefined, true);
  shared.attach('unrelated-request', 1);
  assert.equal(shared.guest(), undefined);
  shared.attach(requests[0].id, 2);
  assert.match(await first, /in new shared tab 2/);
  shared.attach(requests[1].id, 3);
  assert.match(await second, /in new shared tab 3/);
  assert.deepEqual(list(), [2, 3]);

  // Several shared tabs require a tab id.
  await assert.rejects(shared.navigate('https://example.test/next'), /Several tabs/);
  await assert.rejects(shared.navigate('https://example.test/next', 1), /Tab 1 is not shared/);
  for (const url of ['/relative', 'file:///tmp/example', 'https://']) {
    await assert.rejects(shared.navigate(url, 3), /absolute HTTP or HTTPS/);
  }
  assert.match(await shared.navigate('https://example.test/next', 3), /shared tab 3/);
  assert.equal(urls.get(3), 'https://example.test/next');
  assert.equal(urls.get(2), 'https://example.test/new');

  // A manually shared tab is added without unsharing the others.
  shared.share(1);
  assert.deepEqual(list(), [2, 3, 1]);
  assert.equal(shared.guest(1), guests.get(1));

  // Revoking one tab keeps the rest; revoking without an id clears all of them.
  shared.revoke(2);
  assert.deepEqual(list(), [3, 1]);
  shared.revoke();
  assert.deepEqual(list(), []);
  assert.deepEqual(revoked, [2, 3, 1]);
  assert.deepEqual(statuses.map(status => status.slice(1)), [[2, true], [3, true], [1, true], [2, false], [3, false], [1, false]]);

  const canceled = shared.navigate('https://example.test/canceled');
  shared.revoke();
  shared.attach(requests[2].id, 2);
  await assert.rejects(canceled, /did not finish opening/);
  assert.equal(shared.guest(), undefined);
});

test('show_mock waits for a newly opened tab to attach without polling', async () => {
  const { tabs, connect } = setup({ attachLater: true });
  const show = connect();
  const result = await show('<p>Ready</p>');
  assert.equal(result.isError, undefined);
  assert.equal(tabs.length, 1);
});

test('picker selects the nearest HTML element instead of SVG children', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button aria-label="Search"><svg><path d="M0 0"></path></svg></button>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.CSS = { escape: value => value };
  const pick = loadPicker(window);

  try {
    const result = pick();
    window.document.querySelector('path').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const selected = await result;
    assert.equal(selected.tag, 'button');
    assert.equal(selected.label, 'Search');
    assert.equal(window.document.querySelector(selected.selector), window.document.querySelector('button'));
    window.envimElementPicker.stop();
  } finally {
    window.close();
  }
});

test('a shared tab is revoked when it leaves HTTP(S), and sharing it again is a no-op', () => {
  const { EventEmitter } = require('node:events');
  const guest = Object.assign(new EventEmitter(), {
    id: 5, getType: () => 'webview', url: 'https://example.test/', getURL() { return this.url; }, isDestroyed: () => false,
  });
  const statuses = [];
  const shared = new (loadSharedBrowser(() => guest))({ send: (...args) => statuses.push(args) });

  shared.share(guest.id);
  shared.share(guest.id);
  assert.equal(shared.guest(), guest);
  assert.equal(shared.has(guest.id), true);

  // Moving within the web keeps the tab shared.
  guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://other.test/' });
  guest.url = 'https://other.test/';
  guest.emit('did-navigate');
  assert.equal(shared.guest(), guest);

  // Subframes do not matter, but leaving the web in the main frame ends the share.
  guest.emit('did-start-navigation', { isMainFrame: false, url: 'file:///tmp/frame' });
  assert.equal(shared.guest(), guest);
  guest.emit('did-start-navigation', { isMainFrame: true, url: 'file:///tmp/example' });
  assert.equal(shared.guest(), undefined);
  assert.equal(shared.has(guest.id), false);

  shared.share(guest.id);
  shared.revoke(guest.id);
  assert.deepEqual(statuses.map(status => status.slice(1)), [[5, true], [5, false], [5, true], [5, false]]);
});

test('starting a picker on a tab that is still picking waits for the previous one to stop', async () => {
  const { EventEmitter } = require('node:events');
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    focus() {},
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    // The in-page picker never yields a selection in this test; it only ends when aborted.
    executeJavaScriptInIsolatedWorld: async (_id, [{ code }]) => code.endsWith('.stop()') ? undefined : new Promise(() => {}),
  });
  const { pickElement, stopPicking, isPicking } = loadModule('main/mcp/picker.ts', { electron: {} });
  const order = [];

  const first = pickElement(guest, () => true, () => {}).then(() => order.push('first'));
  const second = pickElement(guest, () => true, () => {}).then(() => order.push('second'));
  await first;
  assert.deepEqual(order, ['first']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isPicking(guest), true);
  stopPicking(guest);
  await second;
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(isPicking(guest), false);
});

test('the workspace browser server serves the tools over MCP to the gateway only', async () => {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const overrides = {
    electron: { webContents: { fromId: () => undefined } },
    'main/mcp/picker': { pickElement: async () => {}, stopPicking: () => {}, isPicking: () => false },
  };
  const { BrowserServer } = loadModule('main/mcp/browserserver.ts', overrides);
  const server = new BrowserServer({ emit: { send() {} }, showBrowserTab: async () => {} });

  try {
    const url = await server.url();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/browser$/);
    assert.equal(await server.url(), url);

    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.deepEqual(tools.sort(), ['downloads', 'handle_dialog', 'read_logs', 'screenshot', 'show_mock', 'use_tab']);
    const listed = await client.callTool({ name: 'use_tab', arguments: { action: 'list' } });
    assert.equal(listed.isError, undefined);
    await client.close();

    // The mock preview is served only once there is one, sandboxed and offline.
    const origin = url.replace('/mcp/browser', '');
    assert.equal((await fetch(`${origin}/mock`)).status, 404);
    server.tools.mock.html = '<p>Mock</p>';
    const mock = await fetch(`${origin}/mock?revision=1`);
    assert.equal(mock.status, 200);
    assert.equal(await mock.text(), '<p>Mock</p>');
    assert.match(mock.headers.get('content-security-policy'), /^sandbox allow-scripts; default-src 'none'/);
    assert.equal((await fetch(`${origin}/mock`, { method: 'POST' })).status, 404);

    // Pages in a browser send Origin, and cannot reach the tools.
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body })).status, 404);
    assert.equal((await fetch(url.replace('/browser', '/other'), { method: 'POST', headers, body })).status, 404);
  } finally {
    server.dispose();
  }
});

test('MCP servers pass the browser tools through the gateway only when asked for', async () => {
  const { Mcp } = loadModule('main/mcp/index.ts', {
    'main/setting': { Setting: { get: () => ({ acp: { mcpServers: [{ enabled: true, server: { name: 'stdio', command: 'tool', args: [], env: [] } }] } }) } },
    'main/envim/workspace': {},
    'main/mcp/browsertools': { BROWSER_TOOLS_SERVER_NAME: 'envim-browser' },
  });
  const synced = [];
  let started = 0;
  const workspace = {
    browser: { url: async () => { started++; return 'http://127.0.0.1:1/mcp/browser'; } },
    mcpGateway: {
      upstreams: { sync: async servers => { synced.push(servers); return new Map(servers.map((server, i) => [server, { id: `up${i}` }])); } },
      app: { onUpstreamsChanged() {} },
      start: async () => 'http://127.0.0.1:2',
    },
  };

  assert.deepEqual(await Mcp.servers(workspace, true), [
    { name: 'stdio', command: 'tool', args: [], env: [] },
    { type: 'http', name: 'envim-browser', url: 'http://127.0.0.1:2/mcp/up0', headers: [] },
  ]);
  assert.deepEqual(synced[0].map(server => server.url), ['http://127.0.0.1:1/mcp/browser']);

  assert.deepEqual(await Mcp.servers(workspace), [{ name: 'stdio', command: 'tool', args: [], env: [] }]);
  assert.equal(started, 1);
});

test('tab logs are cleared only when the tab moves to another site, even if its first navigation was not seen', () => {
  const { EventEmitter } = require('node:events');
  const { TabLogs } = loadModule('main/mcp/tablog.ts', {});
  const guest = Object.assign(new EventEmitter(), {
    id: 41, getURL: () => '', session: { webRequest: { onErrorOccurred() {}, onCompleted() {} } },
  });
  const read = () => TabLogs.read(41, { level: 'debug' }).entries.map(entry => entry.message);
  const start = (url, isSameDocument = false) => guest.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument });
  TabLogs.track(guest);

  // The page loaded before the tab was tracked: only its commit is seen.
  guest.emit('console-message', { message: 'first error', level: 'error', sourceId: '', lineNumber: 1 });
  guest.emit('did-navigate', {}, 'https://a.test/', 200);
  start('https://a.test/next');
  guest.emit('did-navigate', {}, 'https://a.test/next', 200);
  assert.deepEqual(read(), ['first error', 'Navigated to https://a.test/ (HTTP 200)', 'Navigated to https://a.test/next (HTTP 200)']);

  start('https://a.test/next#hash', true);
  assert.equal(read().length, 3);
  start('https://b.test/');
  assert.deepEqual(read(), []);
});
