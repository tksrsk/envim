const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const sdk = require('@agentclientprotocol/sdk/unstable');
const filename = path.resolve(__dirname, '../main/envim/acp.ts');
const loaded = new Module(filename);
loaded.require = name => {
  if (name === 'main/mcp') return { Mcp: { servers: async () => [] } };
  return require(name);
};
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { Acp } = loaded.exports;
const agent = { name: 'fixture', package: { command: ['fixture', '--base'] } };
const terminal = { id: 'terminal', name: 'Terminal', type: 'terminal', args: ['--login'], env: { TEST: 'value' } };
const initialize = { authMethods: [terminal, { id: 'agent', name: 'Agent' }], agentCapabilities: {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const handlers = {}, calls = [], sent = [], requests = [];
  const defaults = async (name, args) => name === 'EnvimAcpStart' ? 'executed' : name === 'jobwait' ? [0] : 0;
  let rpc = defaults;
  const invoke = async (name, args) => { calls.push([name, args]); return rpc(name, args); };
  const emit = {
    on: (name, fn) => { handlers[name] = fn; },
    share: async (name, fn, args) => name === 'neovim:function' ? invoke(fn, args) : undefined,
    send: (...args) => sent.push(args), update: (...args) => sent.push(args)
  };
  const acp = new Acp({ emit, nvim: { call: invoke }, cwd: '/workspace' });
  let request = async method => method === sdk.methods.agent.initialize ? structuredClone(initialize) : {};
  let closes = 0, connects = 0;
  const makeConnection = () => ({ close: () => { closes++; }, agent: {
    request: (method, params) => { requests.push([method, params]); return request(method, params); }
  } });
  const dispatch = { ...handlers };
  handlers['acp:agent:start'] = acp.onAcpAgentStart;
  handlers['acp:auth:authenticate'] = acp.onAcpAuthAuthenticate;
  acp.connection = makeConnection();
  acp.state = { status: 'authenticating', agent, initialize: structuredClone(initialize) };
  acp.buildApp = () => ({ connect: () => { connects++; return makeConnection(); } });
  acp.createStream = () => ({});
  return { acp, calls, sent, requests, handlers, dispatch, defaults, setRpc: fn => { rpc = fn; }, setRequest: fn => { request = fn; },
    get closes() { return closes; }, get connects() { return connects; } };
}

test('terminal authentication stops the old process and uses the shared launch', async () => {
  const h = setup();
  const connection = h.acp.connection;
  const stdoutPush = h.acp.stdoutPush;
  await h.handlers['acp:auth:authenticate']('terminal');
  await flush();
  assert.equal(h.acp.state.status, 'authenticating');
  assert.equal(h.acp.connection, connection);
  assert.equal(h.acp.stdoutPush, stdoutPush);
  assert.deepEqual(h.calls[0], ['EnvimAcpStop', []]);
  assert.deepEqual(h.calls[1], ['EnvimAcpStart', [{ ...agent, auth: terminal }]]);
  assert.equal(h.requests.length, 0);
  assert.equal(agent.auth, undefined);
  assert.equal(h.acp.state.agent, h.calls[1][1][0]);
  assert.deepEqual(h.acp.state.agent.auth, terminal);
});

test('successful authentication reconnects and initializes', async () => {
  const h = setup();
  await h.handlers['acp:auth:authenticate']('terminal');
  await flush();
  h.handlers['acp:exited'](0);
  await flush();
  assert.equal(h.acp.state.status, 'connected');
  assert.equal(h.connects, 0);
  assert.equal("auth" in h.calls.at(-1)[1][0], false);
  assert.equal("auth" in h.acp.state.agent, false);
  assert.equal(h.requests[0][0], sdk.methods.agent.initialize);
});

test('failed or interrupted authentication disconnects without restarting either process', async () => {
  for (const code of [7, 130]) {
    const h = setup();
    h.handlers['acp:auth:authenticate']('terminal');
    await flush();
    let cancelled = 0;
    h.acp.permission.pending = () => { cancelled++; };
    h.acp.tool = { old: {} };
    h.acp.sessions = { old: {} };
    h.handlers['acp:exited'](code);
    await flush();
    assert.equal(h.acp.state.status, 'disconnected');
    assert.equal(h.acp.state.agent, undefined);
    assert.match(h.acp.state.error, new RegExp(String(code)));
    assert.equal(h.calls.filter(([name]) => name === 'EnvimAcpStart').length, 1);
    assert.equal(h.requests.length, 0);
    assert.equal(cancelled, 1);
    assert.deepEqual(h.acp.tool, {});
    assert.deepEqual(h.acp.sessions, {});
  }
});

test('terminal startup failure disconnects without reinitializing', async () => {
  const h = setup();
  h.setRpc(async (name, args) => name === 'EnvimAcpStart' && args[0].auth ? null : h.defaults(name));
  h.handlers['acp:auth:authenticate']('terminal');
  await flush();
  assert.equal(h.acp.state.status, 'disconnected');
  assert.equal(h.acp.state.error, undefined);
  assert.equal(h.acp.state.agent, undefined);
  assert.equal(h.calls.filter(([name]) => name === 'EnvimAcpStart').length, 1);
  assert.equal(h.requests.length, 0);
});

test('old process exit performs the existing reset before terminal authentication', async () => {
  const h = setup();
  let cancelled = 0;
  h.acp.permission.pending = () => { cancelled++; };
  h.acp.tool = { old: {} };
  h.acp.sessions = { old: {} };
  h.setRpc(async name => {
    if (name === 'EnvimAcpStop') await h.handlers['acp:exited'](143);
    return h.defaults(name);
  });
  await h.handlers['acp:auth:authenticate']('terminal');
  await flush();
  assert.equal(h.acp.state.status, 'authenticating');
  assert.equal(h.connects, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(h.acp.tool, {});
  assert.deepEqual(h.acp.sessions, {});
});

test('Neovim + real SDK: failure, cancellation, retry and authenticated session', { timeout: 15000 }, async () => {
  const { spawn } = require('node:child_process');
  const { attach } = require('neovim');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'envim-acp-auth-'));
  const child = spawn('nvim', ['--embed', '--headless', '-u', 'NONE', '-n'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const nvim = attach({ proc: child });
  const h = setup();
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out; state: ${JSON.stringify(h.acp.state)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const channel = await nvim.channelId;
    await nvim.executeLua(`_G.envim_connect = function(_, event) vim.rpcnotify(${channel}, 'envim_test', event) end`, []);
    await nvim.command(`luafile ${path.resolve(__dirname, '../lua/acp.lua')}`);
    nvim.on('notification', (method, args) => {
      if (method !== 'envim_test') return;
      const [event, data] = args[0];
      const mapping = { envim_acp_stdout: 'acp:stdout', envim_acp_exited: 'acp:exited',
        envim_acp_error: 'acp:error' };
      if (mapping[event]) h.handlers[mapping[event]](data);
    });
    h.setRpc(async (name, args) => {
      if (name === 'EnvimAcpStart' && args?.[0]?.auth) assert.equal(await nvim.executeLua('return _G.envim_acp == nil', []), true);
      return nvim.call(name, args);
    });
    h.acp.buildApp = Acp.prototype.buildApp;
    h.acp.createStream = Acp.prototype.createStream;
    h.acp.connection = null;
    const fixture = { name: 'Interactive fixture', package: { command: [process.execPath,
      path.resolve(__dirname, 'fixtures/acp-auth-agent.cjs'), '--auth-file', path.join(directory, 'credentials')] } };
    await h.handlers['acp:agent:start'](fixture);
    await wait(() => h.acp.state.status === 'authenticating' && h.acp.state.initialize);
    const connection = h.acp.connection;
    const stdoutPush = h.acp.stdoutPush;
    h.handlers['acp:auth:authenticate']('fixture-login');
    await wait(async () => h.acp.state.status === 'authenticating'
      && await nvim.executeLua('return _G.envim_acp ~= nil and vim.b.terminal_job_id == _G.envim_acp', []));
    const failedBuffer = await nvim.eval('bufnr()');
    await nvim.call('chansend', [await nvim.eval('b:terminal_job_id'), 'FAIL\n']);
    await wait(() => h.acp.state.status === 'disconnected');
    assert.equal(await nvim.executeLua('return _G.envim_acp == nil', []), true);
    assert.equal(h.calls.filter(([name]) => name === 'EnvimAcpStart').length, 2);
    assert.equal(await nvim.call('bufexists', [failedBuffer]), 1);
    assert.match(h.acp.state.error, /7/);
    // A new attempt begins only after an explicit user start.
    await h.handlers['acp:agent:start'](fixture);
    await wait(() => h.acp.state.status === 'authenticating' && h.acp.state.initialize);
    h.handlers['acp:auth:authenticate']('fixture-login');
    await wait(async () => h.acp.state.status === 'authenticating'
      && await nvim.executeLua('return _G.envim_acp ~= nil and vim.b.terminal_job_id == _G.envim_acp', []));
    await nvim.call('chansend', [await nvim.eval('b:terminal_job_id'), '\x03']);
    await wait(() => h.acp.state.status === 'disconnected');
    assert.equal(await nvim.executeLua('return _G.envim_acp == nil', []), true);
    assert.equal(h.calls.filter(([name]) => name === 'EnvimAcpStart').length, 4);
    assert.match(h.acp.state.error, /Exited code/);
    await h.handlers['acp:agent:start'](fixture);
    await wait(() => h.acp.state.status === 'authenticating' && h.acp.state.initialize);
    h.handlers['acp:auth:authenticate']('fixture-login');
    await wait(async () => h.acp.state.status === 'authenticating'
      && await nvim.executeLua('return _G.envim_acp ~= nil and vim.b.terminal_job_id == _G.envim_acp', []));
    assert.equal(h.acp.state.status, 'authenticating');
    await nvim.call('chansend', [await nvim.eval('b:terminal_job_id'), 'GO\n']);
    await wait(() => h.acp.state.status === 'connected');
    await h.handlers['acp:session:create']();
    assert.equal(h.acp.state.sessionId, 'authenticated-session');
    assert.equal(h.calls.filter(([name, args]) => name === 'EnvimAcpStart' && !args?.[0]?.auth).length, 4);
    assert.equal(h.acp.connection, connection);
    assert.equal(h.acp.stdoutPush, stdoutPush);
    // Ordinary disconnect/reconnect uses the very same SDK connection too.
    const job = await nvim.executeLua('return _G.envim_acp', []);
    h.handlers['acp:agent:stop']();
    await nvim.call('jobwait', [[job], 1000]);
    await wait(() => h.acp.state.status === 'disconnected');
    assert.equal(await nvim.executeLua('return _G.envim_acp == nil', []), true);
    await h.handlers['acp:agent:start'](fixture);
    await wait(() => h.acp.state.status === 'connected');
    assert.equal(h.acp.connection, connection);
    assert.equal(h.acp.stdoutPush, stdoutPush);
    await h.handlers['acp:session:create']();
    assert.equal(h.acp.state.sessionId, 'authenticated-session');
    h.handlers['acp:agent:stop']();
  } finally {
    h.handlers['acp:agent:stop']();
    const exited = new Promise(resolve => child.once('exit', resolve));
    void nvim.command('qa!').catch(() => {});
    const kill = setTimeout(() => child.kill(), 1000);
    await exited;
    clearTimeout(kill);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('UI authentication dispatch does not await stopping the old process', async () => {
  const h = setup();
  let done;
  h.setRpc(() => new Promise(resolve => { done = resolve; }));
  assert.equal(h.dispatch['acp:auth:authenticate'], h.acp.onAcpAuthAuthenticate);
  assert.equal(h.dispatch['acp:auth:authenticate']('terminal'), undefined);
  h.setRpc(h.defaults);
  done(0);
  await flush();
});

test('UI start resolves after process launch while initialization is still pending', async () => {
  const h = setup();
  let initialized;
  h.setRequest(() => new Promise(resolve => { initialized = resolve; }));
  await h.dispatch['acp:agent:start'](agent);
  assert.equal(h.acp.state.status, 'connecting');
  h.handlers['acp:error']('existing startup warning');
  initialized(structuredClone(initialize));
  await flush();
  assert.equal(h.acp.state.status, 'connected');
  assert.equal(h.acp.state.error, 'existing startup warning');
});

test('normal process failure disconnects and reports its exit code', async () => {
  const h = setup();
  h.acp.connection = null;
  h.acp.state = { status: 'connecting', agent };
  await h.handlers['acp:exited'](1);
  assert.equal(h.acp.state.status, 'disconnected');
  assert.equal(h.acp.state.error, 'Exited code: 1');
});


test('agent authentication keeps the existing SDK authenticate path', async () => {
  const h = setup();
  assert.equal(h.handlers['acp:auth:authenticate']('agent'), undefined);
  await flush();
  assert.equal(h.acp.state.status, 'connected');
  assert.deepEqual(h.requests[0], [sdk.methods.agent.authenticate, { methodId: 'agent' }]);
  assert.equal(h.calls.length, 0);
});

test('normal process successful exit disconnects without an error', () => {
  const h = setup();
  h.acp.state.status = 'connected';
  h.handlers['acp:exited'](0);
  assert.equal(h.acp.state.status, 'disconnected');
  assert.equal(h.acp.state.error, undefined);
});

test('agent authentication records selection while pending and clears it after success', async () => {
  const h = setup();
  let finish;
  h.setRequest(() => new Promise(resolve => { finish = resolve; }));
  h.handlers['acp:auth:authenticate']('agent');
  assert.equal(h.acp.state.status, 'authenticating');
  assert.equal(h.acp.state.agent.auth.id, 'agent');
  finish({});
  await flush();
  assert.equal(h.acp.state.status, 'connected');
  assert.equal(h.acp.state.agent.auth, undefined);
  assert.equal(h.acp.state.agent, agent);
});

test('failed agent authentication clears selection and stays at authentication choice', async () => {
  for (const error of [new Error('denied'), new sdk.RequestError(-32000, 'login required')]) {
    const h = setup();
    h.setRequest(async () => { throw error; });
    h.handlers['acp:auth:authenticate']('agent');
    await flush();
    assert.equal(h.acp.state.status, 'authenticating');
    assert.equal(h.acp.state.agent.auth, undefined);
    assert.equal(h.acp.state.agent, agent);
    assert.equal(h.acp.state.error, error.message);
    assert.equal(h.calls.length, 0);
    assert.equal(h.requests.length, 1);
    h.setRequest(async () => ({}));
    h.handlers['acp:auth:authenticate']('agent');
    await flush();
    assert.equal(h.acp.state.status, 'connected');
    assert.equal(h.acp.state.agent.auth, undefined);
  }
});

test('normal startup failure clears state, while initialized keeps the existing agent', async () => {
  for (const result of [null, 'initialized']) {
    const h = setup();
    h.setRpc(async () => result);
    await h.handlers['acp:agent:start'](agent);
    assert.equal(h.acp.state.status, result === 'initialized' ? 'connected' : 'disconnected');
    assert.equal(h.acp.state.agent, result === 'initialized' ? agent : undefined);
  }
});
