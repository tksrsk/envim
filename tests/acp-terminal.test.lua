local root = vim.fn.getcwd()
local events = {}
_G.envim_connect = function(_, event) table.insert(events, event) end
dofile(root .. '/lua/acp.lua')
-- RPC delivers a separate decoded table for each call.
local function rpc_start(agent)
  return envim_acp_start(vim.deepcopy(agent))
end
local function check(condition, message)
  if not condition then error(message, 2) end
end
local function wait_for(predicate, message)
  check(vim.wait(5000, predicate, 10), message)
end
local function run()
  local pkg = {
    command = { vim.fn.exepath('node'), root .. '/tests/fixtures/acp-auth-agent.cjs', '--base', 'base value' },
    env = { ENVIM_AUTH_BASE = 'base', ENVIM_AUTH_OVERRIDE = 'package' }
  }
  local original = vim.deepcopy(pkg)
  local jobstart, callbacks = vim.fn.jobstart, nil
  vim.fn.jobstart = function(command, opts)
    callbacks = opts
    return jobstart(command, opts)
  end
  check(rpc_start({ package = pkg, name = 'fixture', version = '1' }) == 'executed', 'normal launch failed')
  check(callbacks.on_stdout ~= nil and not callbacks.term, 'normal stream handlers missing')
  check(rpc_start({ package = pkg, name = 'fixture', version = '1', auth = {} }) == 'initialized', 'concurrent launch accepted')
  envim_acp_stop()
  wait_for(function() return _G.envim_acp == nil end, 'normal job did not stop')
  local function start(mode)
    local before = #events
    check(rpc_start({ package = pkg, name = 'fixture', version = '1', auth = {
      args = { '--auth', mode, 'space value' },
      env = { ENVIM_AUTH_OVERRIDE = 'auth', ENVIM_AUTH_EXTRA = 'extra' }
    } }) == 'executed', 'terminal launch failed')
    check(callbacks.term and callbacks.on_stdout == nil, 'terminal has ACP stream handler')
    local job, buffer, window = _G.envim_acp, vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
    return job, buffer, window, before
  end
  local function exit_code(before)
    wait_for(function() return _G.envim_acp == nil end, 'terminal did not exit')
    check(#events == before + 1, 'unexpected terminal notifications')
    check(events[#events][1] == 'envim_acp_exited', 'dedicated auth exit emitted')
    return events[#events][2]
  end
  local job, buffer, window, before = start('input')
  wait_for(function()
    return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n'):find('"tty":true', 1, true)
  end, 'terminal output missing')
  local output = table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n')
  check(output:find('"BASE":"base"', 1, true) and output:find('"OVERRIDE":"auth"', 1, true)
    and output:find('"EXTRA":"extra"', 1, true), 'environment was not merged')
  check(output:find('space value', 1, true) and output:find('base value', 1, true), 'arguments changed')
  check(vim.deep_equal(pkg, original), 'package was mutated')
  vim.fn.chansend(job, 'GO\n')
  check(exit_code(before) == 0, 'success exit lost')
  check(vim.api.nvim_buf_is_valid(buffer) and vim.api.nvim_get_current_win() == window, 'successful terminal was removed')
  job, buffer, window, before = start('fail')
  check(exit_code(before) == 7 and vim.api.nvim_buf_is_valid(buffer), 'failed output removed')
  job, buffer, window, before = start('instant')
  check(exit_code(before) == 0 and vim.api.nvim_buf_is_valid(buffer), 'instant exit lost')
  job, buffer, window, before = start('input')
  wait_for(function()
    return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n'):find('"tty":true', 1, true)
  end, 'interactive terminal not ready')
  vim.cmd.tabprevious()
  local other = vim.api.nvim_get_current_win()
  vim.fn.chansend(job, '\003')
  check(exit_code(before) ~= 0, 'Ctrl-C did not interrupt')
  check(vim.api.nvim_get_current_win() == other and vim.api.nvim_buf_is_valid(buffer), 'exit moved user focus')
  job, buffer, window, before = start('input')
  envim_acp_stop()
  exit_code(before)
  local tabs = #vim.api.nvim_list_tabpages()
  check(rpc_start({ package = { command = { '/nonexistent-envim-test-executable' } }, name = 'missing', version = '1' }) ~= 'executed', 'missing command accepted')
  -- A failed terminal launch must not leave the newly created tab behind.
  local saved_start, failed_buffer = vim.fn.jobstart, nil
  vim.fn.jobstart = function() failed_buffer = vim.api.nvim_get_current_buf(); return -1 end
  check(rpc_start({ package = pkg, name = 'fixture', version = '1', auth = {} }) ~= 'executed', 'failed terminal accepted')
  vim.fn.jobstart = saved_start
  check(#vim.api.nvim_list_tabpages() == tabs, 'failed startup leaked a tab')
  check(not vim.api.nvim_buf_is_valid(failed_buffer), 'failed startup leaked a buffer')
  -- Neovim escalates a SIGTERM-ignoring process to SIGKILL while stop waits.
  local stubborn = { name = 'stubborn', package = { command = {
    vim.fn.exepath('node'), '-e',
    "process.on('SIGTERM',()=>{}); console.log('stop-ready'); setInterval(()=>{},1000)"
  } } }
  check(rpc_start(stubborn) == 'executed', 'stubborn process did not start')
  wait_for(function()
    for _, event in ipairs(events) do
      if event[1] == 'envim_acp_stdout' and event[2] == 'stop-ready' then return true end
    end
    return false
  end, 'stubborn process not ready')
  local result = envim_acp_stop()
  check((result >= 0 or result == -3) and _G.envim_acp == nil, 'stop returned before process exited: ' .. tostring(result))
  check(envim_acp_stop() == 0, 'stopping with no process failed')
  print('ACP terminal integration tests passed')
end
local ok, failure = xpcall(run, debug.traceback)
if _G.envim_acp then pcall(envim_acp_stop) end
if not ok then io.stderr:write(failure .. '\n'); vim.cmd('cquit 1') end
vim.cmd('qa!')
