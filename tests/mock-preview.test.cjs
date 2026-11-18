const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

function loadBrowserModule(file, load = require) {
  const filename = path.resolve(__dirname, '../main/mcp', file);
  const loaded = new Module(filename);
  loaded.require = load;
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  return loaded.exports;
}

function setup() {
  const filename = path.resolve(__dirname, '../main/mcp/preview.ts');
  const loaded = new Module(filename);
  const tabs = [];
  loaded.require = name => {
    if (name === 'electron') return { webContents: { fromId: id => tabs[id] } };
    if (name === 'main/mcp/browser-page') return loadBrowserModule('browser-page.ts');
    if (name === 'main/mcp/shared-browser') return loadBrowserModule('shared-browser.ts', loaded.require);
    if (name === 'main/mcp/pick-element') return { pickMockElement: () => null };
    return require(name);
  };
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  const { MockPreview } = loaded.exports;
  const service = new MockPreview({
    showBrowserTab: async url => {
      const id = tabs.push({
        url,
        reloads: 0,
        getType: () => 'webview',
        isDestroyed: () => false,
        isLoadingMainFrame: () => false,
        getURL() { return this.url; },
        async loadURL(url) { this.url = url; this.reloads++; }
      }) - 1;
      service.attach(url, id);
    }
  });

  function connect(chat) {
    const handlers = {};
    const endpoint = service.endpoint(chat);
    service.registerTools({ setRequestHandler: (name, handler) => { handlers[name] = handler; } }, endpoint);
    return html => handlers['tools/call']({ params: { name: 'show_mock', arguments: { html } } });
  }

  return { service, tabs, connect, serve: url => MockPreview.serve(new Request(url)) };
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
  const { service, tabs, connect, serve } = setup();
  const showFirst = connect('first');
  const showSecond = connect('second');
  assert.equal((await showFirst('')).isError, true);
  await showFirst('<p>First</p>');
  await showSecond('<p>Second</p>');
  assert.notEqual(tabs[0].url, tabs[1].url);
  service.remove('first');
  assert.equal((await showFirst('<p>Old chat</p>')).isError, true);
  assert.equal(serve(tabs[0].url).status, 404);
  assert.equal(await serve(tabs[1].url).text(), '<p>Second</p>');
});

test('picker keeps an outline after choosing, supports reselection, and clears on Escape', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button>Open settings</button><button>Close settings</button>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.CSS = { escape: value => value };
  const source = readFileSync(path.resolve(__dirname, '../main/mcp/pick-element.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const picker = window.eval('(() => { const exports = {}; ' + js + '; return exports.pickMockElement; })()');
  const { pageSelector } = loadBrowserModule('browser-page.ts');
  const pick = () => picker(window.eval('(' + pageSelector.toString() + ')'), 'test-picker', false);

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
  const { SharedBrowser } = loadBrowserModule('shared-browser.ts', name => {
    if (name === 'electron') return { webContents: { fromId: () => guest } };
    if (name === 'main/mcp/browser-page') return loadBrowserModule('browser-page.ts');
    return require(name);
  });
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

test('navigate opens and shares only the new tab reported for this session', async () => {
  const { EventEmitter } = require('node:events');
  const urls = new Map([[1, 'https://example.test/already-open'], [2, 'https://example.test/new']]);
  const guests = new Map(Array.from(urls.keys(), id => [id, Object.assign(new EventEmitter(), {
    id,
    getType: () => 'webview',
    getURL: () => urls.get(id),
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    async loadURL(url) { urls.set(id, url); }
  })]));
  const { SharedBrowser } = loadBrowserModule('shared-browser.ts', name => {
    if (name === 'electron') return { webContents: { fromId: id => guests.get(id) } };
    if (name === 'main/mcp/browser-page') return loadBrowserModule('browser-page.ts');
    return require(name);
  });
  const requests = [], statuses = [];
  const shared = new SharedBrowser({ send: (...args) => statuses.push(args) }, undefined, async (url, id) => {
    requests.push({ url, id });
  });

  const opening = shared.act('first', { action: 'navigate', url: 'https://example.test/new' });
  await assert.rejects(shared.act('first', { action: 'navigate', url: 'https://example.test/duplicate' }), /already opening/);
  shared.attach('unrelated-request', 1);
  assert.equal(shared.guest('first'), undefined);
  shared.attach(requests[0].id, 2);
  assert.match(await opening, /in a new shared tab/);
  assert.equal(shared.guest('first'), guests.get(2));
  assert.equal(shared.guest('second'), undefined);
  assert.deepEqual(statuses.map(status => status.slice(1)), [[2, true]]);
  await shared.act('first', { action: 'navigate', url: 'https://example.test/next' });
  assert.equal(urls.get(2), 'https://example.test/next');
  assert.equal(urls.get(1), 'https://example.test/already-open');
  assert.equal(requests.length, 1);

  const canceled = shared.act('second', { action: 'navigate', url: 'https://example.test/canceled' });
  shared.revoke('second');
  shared.attach(requests[1].id, 1);
  await assert.rejects(canceled, /did not finish opening/);
  assert.equal(shared.guest('second'), undefined);
});
