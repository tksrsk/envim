// A persistent agent process, or an interactive login process when --auth is appended.
const fs = require('node:fs');
const index = process.argv.indexOf('--auth');
const fileIndex = process.argv.indexOf('--auth-file');
const authFile = fileIndex < 0 ? undefined : process.argv[fileIndex + 1];
if (index < 0) {
  if (!authFile) setInterval(() => {}, 1000);
  else {
    // Snapshot credentials at process startup: authentication requires a restart.
    const authenticated = fs.existsSync(authFile);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (!line.trim()) return;
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const response = { jsonrpc: '2.0', id: request.id };
      if (request.method === 'initialize') response.result = {
        protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [{ type: 'terminal', id: 'fixture-login', name: 'Fixture login', args: ['--auth', 'input'] }]
      };
      else if (!authenticated) response.error = { code: -32000, message: 'Authentication required' };
      else if (request.method === 'session/list') response.result = { sessions: [] };
      else if (request.method === 'session/new') response.result = { sessionId: 'authenticated-session' };
      else response.result = {};
      console.log(JSON.stringify(response));
    });
  }
} else {
  const mode = process.argv[index + 1];
  console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
    env: { BASE: process.env.ENVIM_AUTH_BASE, OVERRIDE: process.env.ENVIM_AUTH_OVERRIDE, EXTRA: process.env.ENVIM_AUTH_EXTRA },
    tty: !!process.stdin.isTTY }));
  if (mode === 'instant') process.exit(0);
  if (mode === 'fail') process.exit(7);
  process.stdin.on('data', data => {
    if (data.toString().includes('FAIL')) process.exit(7);
    if (data.toString().includes('GO')) {
      if (authFile) fs.writeFileSync(authFile, 'fixture credentials');
      process.exit(0);
    }
  });
}
