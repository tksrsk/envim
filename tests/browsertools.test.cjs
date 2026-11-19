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
  return {
    url,
    reloads: 0,
    getType: () => 'webview',
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL() { return this.url; },
    async loadURL(url) { this.url = url; this.reloads++; }
  };
}

function setup({ attachLater = false } = {}) {
  const tabs = [];
  const cache = new Map();
  const overrides = {
    electron: { webContents: { fromId: id => tabs[id] } },
    'main/mcp/picker': { pickElement: async () => {}, stopPicking: () => {} },
  };
  const { BrowserTools } = loadModule('main/mcp/browsertools.ts', overrides, cache);
  const { MockPreview } = loadModule('main/mcp/preview.ts', overrides, cache);
  const removed = [];
  const service = new BrowserTools({
    showBrowserTab: async url => {
      const id = tabs.push(createTab(url)) - 1;
      if (attachLater) setTimeout(() => service.attachMock(url, id), 20);
      else service.attachMock(url, id);
    }
  }, endpoint => removed.push(endpoint));

  function connect(chat) {
    const handlers = {};
    const endpoint = service.create(chat);
    service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } }, endpoint);
    return html => handlers['tools/call']({ params: { name: 'show_mock', arguments: { html } } });
  }

  return { service, tabs, removed, connect, serve: url => MockPreview.serve(new Request(url)) };
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

test('publishes an isolated mock and updates it in place without dropping its fragment', async () => {
  const { service, tabs, connect, serve } = setup();
  const show = connect('first');
  assert.equal((await show('<button>Settings</button>')).isError, undefined);
  const [tab] = tabs;
  const response = serve(tab.url);
  assert.match(response.headers.get('content-security-policy'), /^sandbox allow-scripts; default-src 'none'/);
  assert.equal(await response.text(), '<button>Settings</button>');

  tab.url += '#settings=open';
  // A second guest can display the same URL. Only the registered tab should refresh.
  const otherGuest = { ...tab };
  tabs.push(otherGuest);
  await show('<button>Preferences</button>');
  assert.equal(tabs.length, 2);
  assert.equal(tab.reloads, 1);
  assert.match(tab.url, /[?]revision=[^#]+#settings=open$/);
  const revisedUrl = tab.url;
  await show('<button>Profile</button>');
  assert.equal(tabs.length, 2);
  assert.equal(tab.reloads, 2);
  assert.equal(otherGuest.reloads, 0);
  assert.notEqual(tab.url, revisedUrl);
  assert.equal(await serve(tab.url).text(), '<button>Profile</button>');

  service.dispose();
  assert.equal(serve(tab.url).status, 404);
});

test('keeps chats independent and rejects writes after removal', async () => {
  const { service, tabs, removed, connect, serve } = setup();
  const showFirst = connect('first');
  const showSecond = connect('second');
  assert.equal((await showFirst('')).isError, true);
  await showFirst('<p>First</p>');
  await showSecond('<p>Second</p>');
  assert.notEqual(tabs[0].url, tabs[1].url);
  service.remove('first');
  assert.deepEqual(removed, ['browser-first']);
  assert.equal((await showFirst('<p>Old chat</p>')).isError, true);
  assert.equal(serve(tabs[0].url).status, 404);
  assert.equal(await serve(tabs[1].url).text(), '<p>Second</p>');
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

test('shared browser actions follow HTTP(S) navigation in the same tab and stop at non-web pages', async () => {
  const { EventEmitter } = require('node:events');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button id="details">Details</button><input id="search"><textarea id="notes" readonly></textarea>', {
    url: 'https://example.test/', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.CSS = { escape: value => value };
  const button = window.document.querySelector('button');
  for (const el of window.document.querySelectorAll('button,input,textarea')) {
    el.getClientRects = () => [{}];
    el.scrollIntoView = () => {};
  }
  const input = window.document.querySelector('#search');
  let received;
  input.addEventListener('input', event => { received = event.target.value; });
  let clicks = 0, scroll = 0;
  window.scrollBy = (_x, y) => { scroll += y; };
  button.onclick = () => { clicks++; };

  const guest = Object.assign(new EventEmitter(), {
    id: 3,
    getType: () => 'webview',
    getURL: () => window.location.href,
    async loadURL(url) {
      this.emit('did-start-navigation', { isMainFrame: true, url });
      dom.reconfigure({ url });
      this.emit('did-navigate');
    },
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async (_id, scripts) => window.eval(scripts[0].code)
  });
  const statuses = [];
  const SharedBrowser = loadSharedBrowser(() => guest);
  const shared = new SharedBrowser({ send: (...args) => statuses.push(args) });

  try {
    await assert.rejects(shared.act('one', { action: 'inspect' }), /No web tab/);
    shared.share('one', guest.id);
    assert.deepEqual(Array.from((await shared.act('one', { action: 'inspect' })).elements, element => element.selector), ['#details', '#search', '#notes']);
    await assert.rejects(shared.act('two', { action: 'click', selector: '#details' }), /No web tab/);
    await shared.act('one', { action: 'click', selector: '#details' });
    assert.equal(clicks, 1);
    await shared.act('one', { action: 'scroll', pixels: 200 });
    assert.equal(scroll, 200);
    await shared.act('one', { action: 'type', selector: '#search', text: 'hello' });
    assert.equal(received, 'hello');
    await shared.act('one', { action: 'type', selector: '#search', text: '' });
    assert.equal(received, '');
    await assert.rejects(shared.act('one', { action: 'type', selector: '#notes', text: 'hello' }), /not an editable/);
    guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.test/details' });
    dom.reconfigure({ url: 'https://example.test/details' });
    guest.emit('did-navigate');
    assert.equal((await shared.act('one', { action: 'inspect' })).url, 'https://example.test/details');
    guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://other.test/' });
    dom.reconfigure({ url: 'https://other.test/' });
    guest.emit('did-navigate');
    assert.equal((await shared.act('one', { action: 'inspect' })).url, 'https://other.test/');
    for (const url of ['/relative', 'file:///tmp/example', 'https://']) {
      await assert.rejects(shared.act('one', { action: 'navigate', url }), /absolute HTTP or HTTPS/);
    }
    assert.match(await shared.act('one', { action: 'navigate', url: 'https://example.test/direct' }), /example\.test\/direct/);
    assert.equal((await shared.act('one', { action: 'inspect' })).url, 'https://example.test/direct');
    guest.emit('did-start-navigation', { isMainFrame: true, url: 'file:///tmp/example' });
    await assert.rejects(shared.act('one', { action: 'inspect' }), /No web tab/);
    assert.deepEqual(statuses.map(status => status.slice(1)), [[3, true], [3, false]]);
    shared.share('one', guest.id);
    shared.revoke('one', guest.id);
    await assert.rejects(shared.act('one', { action: 'click', selector: '#details' }), /No web tab/);
    assert.equal(clicks, 1);
  } finally {
    window.close();
  }
});

test('shares several tabs per session and targets them by tab id', async () => {
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
  const shared = new SharedBrowser({ send: (...args) => statuses.push(args) }, (endpoint, id) => revoked.push([endpoint, id]), async (url, id) => {
    requests.push({ url, id });
  });

  // With nothing shared, navigate opens a new tab. Two opens can run at the same time.
  const first = shared.act('first', { action: 'navigate', url: 'https://example.test/new' });
  const second = shared.act('first', { action: 'navigate', url: 'https://example.test/other', new_tab: true });
  shared.attach('unrelated-request', 1);
  assert.equal(shared.guest('first'), undefined);
  shared.attach(requests[0].id, 2);
  assert.match(await first, /in new shared tab 2/);
  shared.attach(requests[1].id, 3);
  assert.match(await second, /in new shared tab 3/);
  assert.deepEqual(await shared.act('first', { action: 'list' }), [
    { tab: 2, url: 'https://example.test/new', title: 'Tab 2' },
    { tab: 3, url: 'https://example.test/other', title: 'Tab 3' },
  ]);

  // Several shared tabs require a tab id.
  await assert.rejects(shared.act('first', { action: 'navigate', url: 'https://example.test/next' }), /Several tabs/);
  await assert.rejects(shared.act('first', { action: 'inspect', tab: 1 }), /Tab 1 is not shared/);
  assert.match(await shared.act('first', { action: 'navigate', url: 'https://example.test/next', tab: 3 }), /shared tab 3/);
  assert.equal(urls.get(3), 'https://example.test/next');
  assert.equal(urls.get(2), 'https://example.test/new');

  // A manually shared tab is added without unsharing the others.
  shared.share('first', 1);
  assert.deepEqual((await shared.act('first', { action: 'list' })).map(tab => tab.tab), [2, 3, 1]);
  assert.equal(shared.guest('first', 1), guests.get(1));

  // Sharing a tab with another session moves it there.
  shared.share('second', 1);
  assert.deepEqual((await shared.act('first', { action: 'list' })).map(tab => tab.tab), [2, 3]);
  assert.equal(shared.guest('second'), guests.get(1));

  // Revoking one tab keeps the rest; revoking the session clears all of them.
  shared.revoke('first', 2);
  assert.equal(shared.guest('first'), guests.get(3));
  shared.revoke('first');
  assert.deepEqual(await shared.act('first', { action: 'list' }), []);
  assert.deepEqual(revoked, [['first', 1], ['first', 2], ['first', 3]]);
  assert.deepEqual(statuses.map(status => status.slice(1)),
    [[2, true], [3, true], [1, true], [1, false], [1, true], [2, false], [3, false]]);

  const canceled = shared.act('third', { action: 'navigate', url: 'https://example.test/canceled' });
  shared.revoke('third');
  shared.attach(requests[2].id, 2);
  await assert.rejects(canceled, /did not finish opening/);
  assert.equal(shared.guest('third'), undefined);
});

test('waits for a newly opened mock tab to attach without polling', async () => {
  const { tabs, connect } = setup({ attachLater: true });
  const show = connect('first');
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

test('a tab can be unshared regardless of which session it is shared with', () => {
  const { EventEmitter } = require('node:events');
  const guest = Object.assign(new EventEmitter(), {
    id: 5, getType: () => 'webview', getURL: () => 'https://example.test/', isDestroyed: () => false,
  });
  const statuses = [];
  const SharedBrowser = loadSharedBrowser(() => guest);
  const shared = new SharedBrowser({ send: (...args) => statuses.push(args) });

  shared.share('inactive', guest.id);
  shared.share('active', guest.id);
  assert.equal(shared.guest('inactive'), undefined);
  assert.equal(shared.guest('active'), guest);
  shared.revokeGuest(guest.id);
  assert.equal(shared.guest('active'), undefined);
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

  const first = pickElement('one', guest, () => true, () => {}).then(() => order.push('first'));
  const second = pickElement('two', guest, () => true, () => {}).then(() => order.push('second'));
  await first;
  assert.deepEqual(order, ['first']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isPicking(guest), true);
  stopPicking('two', guest.id);
  await second;
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(isPicking(guest), false);
});
