const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const Module = require('node:module');
const { tmpdir } = require('node:os');
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

test('file tools pass decoded files with their original names and clean up afterwards', async () => {
  const { callFileTool, connectPlaywrightTools } = loadModule('main/browser/mcp/playwright-tools.ts');
  const client = await connectPlaywrightTools(async () => { throw new Error('Unexpected browser connection'); });
  const signal = new AbortController().signal;
  let paths;
  try {
    client.callTool = async ({ name, arguments: args }) => {
      assert.equal(name, 'browser_drop');
      assert.deepEqual(args.data, { 'text/plain': 'label' });
      paths = args.paths;
      assert.deepEqual(paths.map(file => path.basename(file)), ['example.csv', 'example.csv']);
      assert.deepEqual(await Promise.all(paths.map(file => readFile(file, 'utf8'))), ['a,b', 'c,d']);
      return { content: [] };
    };
    await callFileTool(client, 'browser_drop', { target: 'input', data: { 'text/plain': 'label' }, files: [
      { name: 'example.csv', base64: 'YSxi' }, { name: 'example.csv', base64: 'Yyxk' },
    ] }, signal);
    for (const file of paths) await assert.rejects(readFile(file), { code: 'ENOENT' });
    await assert.rejects(callFileTool(client, 'browser_file_upload', { paths: ['/tmp/local.txt'] }, signal), /Send file contents/);
    await assert.rejects(callFileTool(client, 'browser_file_upload', { files: [{ name: '../a', base64: 'YQ==' }] }, signal), /valid filename/);
    await assert.rejects(callFileTool(client, 'browser_file_upload', { files: [{ name: 'a', base64: '====' }] }, signal), /valid Base64/);
  } finally {
    await client.close();
  }
});

test('recordings can be read by ID as consecutive binary chunks', async () => {
  const { Downloads } = loadModule('main/browser/mcp/downloads.ts');
  const downloads = new Downloads(() => {}, () => false);
  const directory = await mkdtemp(path.join(tmpdir(), 'envim-video-test-'));
  try {
    const file = path.join(directory, 'recording.webm');
    const bytes = Buffer.concat([Buffer.alloc(256 * 1024, 42), Buffer.from('final bytes')]);
    await writeFile(file, bytes);
    const [recording] = await downloads.registerVideos([file], new AbortController().signal);
    assert.deepEqual(downloads.list(), [recording]);
    const [first, firstData] = await downloads.read(recording.id);
    const [last, lastData] = await downloads.read(recording.id, JSON.parse(first.text).nextOffset);
    assert.equal(JSON.parse(last.text).nextOffset, null);
    assert.deepEqual(Buffer.concat([firstData, lastData].map(item => Buffer.from(item.resource.blob, 'base64'))), bytes);
    await assert.rejects(downloads.read(recording.id, bytes.length + 1), /within the recording/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

class FakePlaywrightWorkspace {
  guests = [];
  selected;
  constructor(available, open) { this.open = () => open(new AbortController().signal); }
  async sync(guests) {
    this.guests = guests;
    if (!guests.includes(this.selected)) this.selected = guests[0];
  }
  remove(guest) {
    const index = this.guests.indexOf(guest);
    if (index < 0) return;
    this.guests.splice(index, 1);
    if (this.selected === guest) this.selected = this.guests[Math.min(index, this.guests.length - 1)];
  }
  close() {}
  async callTool(name, { action, index, url } = {}) {
    if (name !== 'browser_tabs') return { content: [{ type: 'text', text: this.selected.getURL() }] };
    if (action === 'new' || (action === 'list' && !this.guests.length)) {
      const guest = await this.open();
      if (url) await guest.loadURL(url);
      this.guests.push(guest);
      this.selected = guest;
    }
    if (action === 'select') {
      if (!this.guests[index]) return { isError: true, content: [{ type: 'text', text: 'Tab not found' }] };
      this.selected = this.guests[index];
    }
    return { content: [{ type: 'text', text: this.guests.map((guest, index) =>
      `- ${index}: ${guest === this.selected ? '(current) ' : ''}(${guest.getURL()})`).join('\n') }] };
  }
}

function setup({ openLater = false } = {}) {
  const tabs = [];
  const cache = new Map();
  const overrides = {
    electron: { webContents: { fromId: id => tabs[id], getAllWebContents: () => tabs } },
  };
  overrides['main/browser/mcp/playwright'] = { PlaywrightWorkspace: FakePlaywrightWorkspace };
  const { registerBrowserOwner } = loadModule('main/browser/mcp/sharedbrowser.ts', overrides, cache);
  const { BrowserTools } = loadModule('main/browser/mcp/tools.ts', overrides, cache);
  const listeners = {};
  const service = new BrowserTools({
    id: 'workspace',
    emit: { on: (event, listener) => { listeners[event] = listener; }, send() {}, update() {} },
    browserTabs: { setShared() {}, open: async url => {
      const id = tabs.length;
      tabs.push(Object.assign(createTab(url), { id }));
      registerBrowserOwner(tabs[id], 'workspace');
      if (openLater) await new Promise(resolve => setTimeout(resolve, 20));
      return tabs[id];
    } }
  }, async () => 'http://127.0.0.1:1');

  function connect() {
    const handlers = {};
    service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } });
    const call = (name, args) => handlers['tools/call']({ params: { name, arguments: args } });
    return Object.assign(html => call('show_mock', { html }), { call });
  }

  return { service, tabs, connect, listeners, registerBrowserOwner };
}

function loadSharedBrowser(fromId) {
  return loadModule('main/browser/mcp/sharedbrowser.ts', { electron: { webContents: { fromId } } });
}

test('show_mock opens a shared tab on the served page and updates it in place without dropping its fragment', async () => {
  const { service, tabs, connect, listeners } = setup();
  const show = connect();
  assert.equal((await show('')).isError, true);
  assert.equal(tabs.length, 0);

  const opened = await show('<button>Settings</button>');
  assert.equal(opened.isError, undefined);
  assert.match(opened.content[0].text, /in new shared tab 0/);
  assert.equal(service.mock.html, '<button>Settings</button>');
  const [tab] = tabs;
  assert.equal(tab.url, 'http://127.0.0.1:1/mock');
  assert.match((await show.call('browser_tabs', { action: 'list' })).content[0].text, /current.*\/mock/);

  // Updating reloads the tab at a new revision and keeps the page's state in the fragment.
  tab.url += '#settings=open';
  assert.match((await show('<button>Preferences</button>')).content[0].text, /Updated the mock preview in shared tab 0/);
  assert.equal(tabs.length, 1);
  assert.equal(tab.reloads, 1);
  assert.match(tab.url, /\/mock\?revision=[^#]+#settings=open$/);

  // A tab that is no longer shared is shared again, not duplicated.
  listeners['browser:share:toggle'](tab.id, false);
  await show('<button>Profile</button>');
  assert.equal(tabs.length, 1);
  assert.equal(tab.reloads, 2);
  assert.equal((await show.call('browser_tabs', { action: 'list' })).content[1].text, 'Envim tab IDs by index: 0: 0');

  const next = connect();
  assert.equal(service.mock.html, '<button>Profile</button>');
  assert.match((await next.call('browser_tabs', { action: 'list' })).content[0].text, /current.*\/mock/);

  service.dispose();
  assert.equal(service.mock.html, undefined);
  assert.equal((await next.call('browser_tabs', { action: 'list' })).isError, true);
});

test('the native picker clears highlights and reports confirmed elements', () => {
  const { JSDOM } = require('jsdom');
  const { window } = new JSDOM('<button id="first"><svg><path></path></svg></button><button id="second"></button><svg id="standalone"><path></path></svg>', { runScripts: 'outside-only' });
  const filename = 'main/browser/tabs.ts';
  const source = ts.createSourceFile(filename, readFileSync(path.resolve(__dirname, '..', filename), 'utf8'), ts.ScriptTarget.ES2022);
  const picker = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'pickScript');
  const { outputText } = ts.transpileModule(picker.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const pickScript = new Function(outputText + '\nreturn pickScript;')();

  try {
    const first = window.document.querySelector('#first');
    const second = window.document.querySelector('#second');
    const standalone = window.document.querySelector('#standalone path');
    const messages = [];
    window.console.info = message => messages.push(message);
    const pick = token => window.eval(pickScript(token));
    const dispatch = (type, element) => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
    pick('first-pick');
    dispatch('pointermove', first.querySelector('path'));
    assert.equal(first.getAttribute('data-envim-picking'), 'first-pick');
    pick(null);
    assert.equal(window.document.querySelectorAll('[data-envim-picking]').length, 0);

    for (const token of ['first-pick', 'second-pick']) {
      pick(token);
      dispatch('pointermove', first);
      assert.equal(dispatch('click', second), false);
      assert.equal(first.hasAttribute('data-envim-picking'), false);
      assert.equal(window.document.querySelector(`[data-envim-picked~="${token}"]`), second);
    }
    pick('svg-pick');
    dispatch('click', window.document.body);
    dispatch('click', standalone);
    assert.equal(window.document.querySelector('[data-envim-picked~="svg-pick"]'), standalone);
    assert.deepEqual(messages, ['envim-picked:first-pick', 'envim-picked:second-pick', 'envim-picked:svg-pick']);
  } finally {
    window.close();
  }
});

test('browser tab snapshots include sharing and omit closed tabs', async () => {
  const handlers = new Map();
  const updates = [];
  const guest = Object.assign(createTab('about:blank'), {
    id: 7,
    isFocused: () => false,
    getZoomLevel: () => 0,
    close() { this.emit('destroyed'); },
  });
  const { BrowserTabs } = loadModule('main/browser/tabs.ts', {
    electron: { WebContentsView: class {
      webContents = guest;
      setBounds() {}
      setVisible() {}
    } },
    'main/bootstrap': { Bootstrap: { win: {
      isDestroyed: () => false,
      contentView: { addChildView() {}, removeChildView() {} },
    } } },
    'main/browser/page': { BrowserPage: class {} },
  });
  const tabs = new BrowserTabs('workspace', {
    on: (event, handler) => handlers.set(event, handler),
    send: (event, state) => { if (event === 'browser:tabs:changed') updates.push(state); },
  });
  const getTabs = handlers.get('browser:tabs:get');
  await tabs.open('https://example.test/', false);
  assert.equal(getTabs().tabs[0].shared, false);
  tabs.setShared(guest.id, true);
  assert.equal(getTabs().tabs[0].shared, true);
  assert.deepEqual(updates.at(-1), getTabs());
  handlers.get('browser:tabs:close')(guest.id);
  assert.deepEqual(getTabs().tabs, []);
  assert.deepEqual(updates.at(-1), getTabs());
});

test('opens and shares tabs independently and aborts a pending open', async () => {
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
  const { SharedBrowser, registerBrowserOwner } = loadSharedBrowser(id => guests.get(id));
  for (const guest of guests.values()) registerBrowserOwner(guest, 'workspace');
  const requests = [], statuses = [], revoked = [];
  const shared = new SharedBrowser('workspace', (...args) => statuses.push(args), guest => revoked.push(guest.id), url => {
    return new Promise(resolve => requests.push({ url, resolve }));
  });
  const list = () => shared.guests().map(guest => guest.id);
  const open = (url, signal = new AbortController().signal) => shared.open(url, signal);

  const first = open('https://example.test/new');
  const second = open('https://example.test/other');
  assert.deepEqual(list(), []);
  requests[0].resolve(guests.get(2));
  assert.equal(await first, guests.get(2));
  requests[1].resolve(guests.get(3));
  assert.equal(await second, guests.get(3));
  assert.deepEqual(list(), [2, 3]);

  for (const url of ['/relative', 'file:///tmp/example', 'https://']) {
    await assert.rejects(open(url), /absolute HTTP or HTTPS/);
  }

  // A manually shared tab is added without unsharing the others.
  shared.share(1);
  assert.deepEqual(list(), [2, 3, 1]);
  assert.equal(shared.has(1), true);

  // Revoking one tab keeps the rest; revoking without an id clears all of them.
  shared.revoke(2);
  assert.deepEqual(list(), [3, 1]);
  const pending = open('https://example.test/pending');
  shared.revoke();
  assert.deepEqual(list(), []);
  assert.deepEqual(revoked, [2, 3, 1]);
  assert.deepEqual(statuses, [[2, true], [3, true], [1, true], [2, false], [3, false], [1, false]]);

  requests[2].resolve(guests.get(2));
  assert.equal(await pending, guests.get(2));
  shared.revoke(2);

  const controller = new AbortController();
  const canceled = open('https://example.test/canceled', controller.signal);
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  requests[3].resolve(guests.get(2));
  await Promise.resolve();
  assert.deepEqual(list(), []);
});

test('show_mock waits for a newly opened tab before sharing', async () => {
  const { tabs, connect } = setup({ openLater: true });
  const show = connect();
  const result = await show('<p>Ready</p>');
  assert.equal(result.isError, undefined);
  assert.equal(tabs.length, 1);
});

test('a shared tab is unavailable outside HTTP(S) and becomes available again on return', () => {
  const { EventEmitter } = require('node:events');
  const guest = Object.assign(new EventEmitter(), {
    id: 5, getType: () => 'webview', url: 'about:blank', getURL() { return this.url; }, isDestroyed: () => false,
  });
  const statuses = [];
  const { SharedBrowser, registerBrowserOwner } = loadSharedBrowser(() => guest);
  registerBrowserOwner(guest, 'workspace');
  const shared = new SharedBrowser('workspace', (...args) => statuses.push(args));

  shared.share(guest.id);
  shared.share(guest.id);
  assert.deepEqual(shared.guests(), []);
  assert.equal(shared.has(guest.id), false);
  assert.deepEqual(statuses, [[5, true]]);

  // Opening an HTTP(S) page makes the shared tab available.
  guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://other.test/' });
  guest.url = 'https://other.test/';
  guest.emit('did-navigate');
  assert.deepEqual(shared.guests(), [guest]);

  guest.url = 'about:blank';
  guest.emit('did-navigate');
  assert.deepEqual(shared.guests(), []);
  assert.equal(shared.has(guest.id), false);

  guest.url = 'https://other.test/';
  guest.emit('did-navigate');
  assert.deepEqual(shared.guests(), [guest]);
  assert.equal(shared.has(guest.id), true);

  guest.url = 'about:blank';
  shared.revoke(guest.id);
  guest.url = 'https://other.test/';
  assert.deepEqual(shared.guests(), []);
  assert.deepEqual(statuses, [[5, true], [5, false]]);
});

test('the workspace browser server serves the tools over MCP to the gateway only', async () => {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const overrides = {
    electron: { webContents: { fromId: () => undefined } },
  };
  const { BrowserServer } = loadModule('main/browser/mcp/server.ts', overrides);
  const server = new BrowserServer({ id: 'workspace', emit: { on() {}, send() {} }, browserTabs: { setShared() {} } });

  try {
    const url = await server.url();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/browser$/);
    assert.equal(await server.url(), url);

    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'browser_click', 'browser_console_messages', 'browser_drag', 'browser_drop', 'browser_emulate_media', 'browser_evaluate',
      'browser_file_upload', 'browser_fill_form',
      'browser_find', 'browser_generate_locator', 'browser_handle_dialog', 'browser_hide_highlight', 'browser_highlight',
      'browser_hover', 'browser_mouse_click_xy', 'browser_mouse_down',
      'browser_mouse_drag_xy', 'browser_mouse_move_xy', 'browser_mouse_up', 'browser_mouse_wheel', 'browser_navigate',
      'browser_navigate_back', 'browser_network_request', 'browser_network_requests', 'browser_network_state_set', 'browser_press_key', 'browser_route',
      'browser_route_list', 'browser_select_option', 'browser_snapshot', 'browser_start_recording', 'browser_start_tracing',
      'browser_start_video', 'browser_stop_recording', 'browser_stop_tracing', 'browser_stop_video',
      'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_unroute',
      'browser_verify_element_visible', 'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value',
      'browser_viewport', 'browser_wait_for', 'downloads', 'show_mock',
    ]);
    for (const tool of tools.filter(tool => tool.name.startsWith('browser_') && tool.name !== 'browser_viewport')) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, 'tab'), false);
    }
    assert.ok(tools.find(tool => tool.name === 'browser_wait_for').inputSchema.properties.textGone);
    for (const name of ['browser_file_upload', 'browser_drop']) {
      const { properties } = tools.find(tool => tool.name === name).inputSchema;
      assert.ok(properties.files);
      assert.equal(Object.hasOwn(properties, 'paths'), false);
    }
    assert.deepEqual(tools.find(tool => tool.name === 'browser_tabs').inputSchema.properties.action.enum, ['list', 'new', 'select']);
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
    'main/browser/mcp/tools': { BROWSER_TOOLS_SERVER_NAME: 'envim-browser' },
  });
  const synced = [];
  let started = 0;
  const workspace = {
    browser: {
      url: async () => { started++; return 'http://127.0.0.1:1/mcp/browser'; },
    },
    mcpGateway: {
      upstreams: { sync: async servers => { synced.push(servers); return new Map(servers.map((server, i) => [server, { id: `up${i}` }])); } },
      app: { onUpstreamsChanged() {} },
      start: async () => 'http://127.0.0.1:2',
    },
  };

  assert.deepEqual(await Mcp.servers(workspace, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }), [
    { name: 'stdio', command: 'tool', args: [], env: [] },
    { type: 'http', name: 'envim-browser', url: 'http://127.0.0.1:2/mcp/up0', headers: [] },
  ]);
  assert.deepEqual(synced[0].map(server => server.url), ['http://127.0.0.1:1/mcp/browser']);

  const stdio = [{ name: 'stdio', command: 'tool', args: [], env: [] }];
  assert.deepEqual(await Mcp.servers(workspace, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: false } } }), stdio);
  assert.deepEqual(await Mcp.servers(workspace), stdio);
  assert.equal(started, 1);
});

test('viewport reads, sets and resets the shared tab size', async () => {
  const { service, tabs, connect, listeners, registerBrowserOwner } = setup();
  const tab = Object.assign(createTab('http://localhost:3000'), {
    id: 0,
    size: { width: 900, height: 600 },
    enableDeviceEmulation({ viewSize }) { this.size = viewSize; },
    disableDeviceEmulation() { this.size = { width: 900, height: 600 }; },
    async executeJavaScriptInIsolatedWorld() { return { ok: true, value: this.size }; }
  });
  tabs.push(tab);
  registerBrowserOwner(tab, 'workspace');
  const agent = connect();
  listeners['browser:share:toggle'](0, true);
  const viewport = args => agent.call('browser_viewport', args);
  const size = async args => {
    const result = await viewport(args);
    assert.equal(result.isError, undefined);
    const { width, height } = JSON.parse(result.content[0].text);
    return { width, height };
  };

  assert.deepEqual(await size(), { width: 900, height: 600 });
  assert.deepEqual(await size({ width: 390, height: 844 }), { width: 390, height: 844 });
  assert.equal((await viewport({ width: 400 })).isError, true);
  assert.deepEqual(await size(), { width: 390, height: 844 });
  assert.deepEqual(await size({ reset: true }), { width: 900, height: 600 });

  await size({ width: 390, height: 844 });
  listeners['browser:share:toggle'](0, false);
  assert.deepEqual(tab.size, { width: 900, height: 600 });
  assert.equal((await viewport({ width: 390, height: 844 })).isError, true);

  listeners['browser:share:toggle'](0, true);
  await size({ width: 390, height: 844 });
  const next = connect();
  assert.equal((await next.call('browser_viewport', {})).isError, undefined);
  assert.deepEqual(tab.size, { width: 390, height: 844 });
  service.dispose();
  assert.deepEqual(tab.size, { width: 900, height: 600 });
});

test('device presets apply metrics, touch and UA through a CDP session that survives navigation', async () => {
  const { tabs, connect, listeners, registerBrowserOwner } = setup();
  const device = {};
  const debuggerClient = Object.assign(new (require('node:events').EventEmitter)(), {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() {
      this.attached = false;
      for (const key of Object.keys(device)) delete device[key];
      this.emit('detach');
    },
    async sendCommand(method, params) {
      assert.notEqual(method, 'Emulation.setEmitTouchEventsForMouse');
      if (method === 'Emulation.setDeviceMetricsOverride') device.metrics = params;
      if (method === 'Emulation.clearDeviceMetricsOverride') delete device.metrics;
      if (method === 'Emulation.setTouchEmulationEnabled') device.touch = params;
      if (method === 'Emulation.setUserAgentOverride') device.userAgent = params.userAgent;
    }
  });
  const tab = Object.assign(createTab('http://localhost:3000'), {
    id: 0,
    debugger: debuggerClient,
    async executeJavaScriptInIsolatedWorld() {
      const { width = 900, height = 600, deviceScaleFactor = 1 } = device.metrics ?? {};
      return { ok: true, value: { width, height, devicePixelRatio: deviceScaleFactor } };
    }
  });
  tabs.push(tab);
  registerBrowserOwner(tab, 'workspace');
  const agent = connect();
  listeners['browser:share:toggle'](0, true);
  const viewport = async args => {
    const result = await agent.call('browser_viewport', args);
    assert.equal(result.isError, undefined);
    return JSON.parse(result.content[0].text);
  };

  const android = await viewport({ device: 'Pixel 8' });
  assert.deepEqual(android.emulation, { width: 412, height: 839, device: 'Pixel 8' });
  assert.equal(device.metrics.mobile, true);
  assert.equal(android.devicePixelRatio, 2.625);
  assert.deepEqual(device.touch, { enabled: true, maxTouchPoints: 5 });
  assert.equal(device.metrics.screenHeight, 915);
  assert.equal(device.userAgent, require("playwright-core").devices["Pixel 8"].userAgent);

  await tab.loadURL('http://localhost:3000/next');
  assert.equal((await viewport()).devicePixelRatio, 2.625);
  assert.equal(debuggerClient.isAttached(), true);

  const iphone = await viewport({ device: 'iPhone 14' });
  assert.equal(iphone.devicePixelRatio, 3);
  assert.match(device.userAgent, /iPhone/);

  const ipad = await viewport({ device: 'iPad Mini', width: 1024, height: 768 });
  assert.deepEqual(ipad.emulation, { width: 1024, height: 768, device: 'iPad Mini' });
  assert.match(device.userAgent, /iPad/);

  const laptop = await viewport({ device: 'Desktop Chrome HiDPI' });
  assert.equal(laptop.devicePixelRatio, 2);
  assert.equal(device.metrics.mobile, false);
  assert.equal(device.touch.enabled, false);
  assert.equal(device.userAgent, require("playwright-core").devices["Desktop Chrome HiDPI"].userAgent);

  assert.equal((await viewport({ reset: true })).emulation, null);
  assert.equal(device.metrics, undefined);
  assert.equal(debuggerClient.isAttached(), false);

  await viewport({ device: 'Pixel 8' });
  debuggerClient.detach();
  assert.equal((await viewport()).emulation, null);
});

test('Playwright transport exposes only its shared guest and closes on release', async () => {
  const { EventEmitter } = require('node:events');
  const sent = [];
  const debuggerClient = Object.assign(new EventEmitter(), {
    attached: false,
    attach() { this.attached = true; },
    detach() { this.attached = false; this.emit('detach'); },
    isAttached() { return this.attached; },
    async sendCommand(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'shared', type: 'webview' } };
      return {};
    }
  });
  const page = { isClosed: () => true };
  const messages = [];
  let transport;
  const { PlaywrightWorkspace } = loadModule('main/browser/mcp/playwright.ts', {
    'playwright-core': { chromium: {
      async connectOverCDP(connection, options) {
        transport = connection;
        assert.equal(options.noDefaults, true);
        const context = new EventEmitter();
        context.waitForEvent = event => require('node:events').once(context, event).then(([value]) => value);
        transport.onmessage = message => {
          messages.push(message);
          if (message.method === 'Target.attachedToTarget') context.emit('page', page);
        };
        return { contexts: () => [context] };
      }
    } }
  });
  let available = true;
  const guest = Object.assign(createTab('https://example.test/'), { id: 1, debugger: debuggerClient });
  const privateGuest = Object.assign(createTab('https://private.test/'), { id: 2 });
  const tab = new PlaywrightWorkspace(item => item === guest && available, async () => { throw Error('unexpected open'); });
  await tab.sync([guest, privateGuest]);
  assert.equal(await tab.page(guest), page);
  assert.deepEqual(tab.guests, [guest]);
  const target = messages.find(message => message.method === 'Target.attachedToTarget').params;
  assert.equal(target.targetInfo.targetId, 'shared');
  assert.equal(target.targetInfo.type, 'page');

  debuggerClient.emit('message', {}, 'Page.javascriptDialogOpening', {});
  transport.send({ id: 2, method: 'Target.getTargets' });
  transport.send({ id: 3, method: 'Runtime.enable', sessionId: target.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.some(message => message.method === 'Page.javascriptDialogOpening'), false);
  assert.ok(messages.find(message => message.id === 2).error);
  assert.equal(sent.some(command => command.method === 'Target.getTargets'), false);
  assert.equal(sent.find(command => command.method === 'Runtime.enable').sessionId, undefined);

  available = false;
  transport.send({ id: 4, method: 'Runtime.disable', sessionId: target.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.find(message => message.id === 4).error);
  assert.equal(sent.some(command => command.method === 'Runtime.disable'), false);
  tab.close();
  assert.equal(debuggerClient.isAttached(), false);
});

test('browser_tabs selects the shared tab for official operations', async () => {
  const { tabs, listeners, connect, registerBrowserOwner } = setup();
  for (const path of ['one', 'two', 'private', 'four']) {
    const guest = Object.assign(createTab(`https://example.test/${path}`), { id: tabs.length });
    tabs.push(guest);
    registerBrowserOwner(guest, path === 'private' ? 'other-workspace' : 'workspace');
  }
  const { call } = connect();
  const share = (tab, value) => listeners['browser:share:toggle'](tab, value);
  for (const tab of [0, 1, 2, 3]) share(tab, true);
  const list = async () => (await call('browser_tabs', { action: 'list' })).content;
  const snapshot = async () => (await call('browser_snapshot')).content[0].text;
  assert.equal((await list())[1].text, 'Envim tab IDs by index: 0: 0, 1: 1, 2: 3');
  assert.doesNotMatch((await list())[0].text, /private/);
  assert.equal(await snapshot(), 'https://example.test/one');

  assert.equal((await call('browser_tabs', { action: 'select', index: 2 })).isError, undefined);
  assert.equal(await snapshot(), 'https://example.test/four');
  assert.equal((await call('browser_snapshot', { tab: 2 })).isError, true);
  assert.equal((await call('browser_tabs', { action: 'select', index: 3 })).isError, true);

  share(0, false);
  assert.match((await list())[0].text, /1: \(current\).*four/);
  assert.equal(await snapshot(), 'https://example.test/four');
  const next = connect();
  assert.equal((await next.call('browser_snapshot')).content[0].text, 'https://example.test/four');
  share(3, false);
  assert.equal(await snapshot(), 'https://example.test/two');
});

test('browser_tabs new opens and selects a shared HTTP tab', async () => {
  const { connect } = setup();
  const { call } = connect();
  const open = url => call('browser_tabs', { action: 'new', url });
  assert.equal((await open('file:///tmp/example')).isError, true);
  for (const url of ['https://example.test/first', 'https://example.test/second']) {
    const result = await open(url);
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.ok(result.content[0].text.split('\n').some(line => line.includes('(current)') && line.includes(url)));
  }
});
