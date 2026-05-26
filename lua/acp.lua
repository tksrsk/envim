_G.envim_acp_start = function(pkg)

  if _G.envim_acp then
    return "initialized"
  end

  if not pkg or type(pkg.command) ~= "table" or #pkg.command == 0 then
    return nil
  end

  local success, result = pcall(vim.fn.jobstart, pkg.command, {
    env = pkg.env,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line and line ~= "" then
          envim_connect(0, { "envim_acp_stdout", line })
        end
      end
    end,
    on_exit = function()
      _G.envim_acp = nil
      envim_connect(0, { "envim_acp_exited" })
    end
  })

  if success and result > 0 then
    _G.envim_acp = result
    return "executed"
  else
    _G.envim_acp = nil
    return nil
  end
end

_G.envim_acp_stop = function()
  if _G.envim_acp then
    vim.fn.jobstop(_G.envim_acp)

    vim.defer_fn(function()
      pcall(vim.fn.jobstop, _G.envim_acp)

      _G.envim_acp = nil
    end, 5000)
  end
end

_G.envim_acp_send = function(message)
  if _G.envim_acp and message then
    local success, error = pcall(vim.fn.chansend, _G.envim_acp, message .. "\n")

    if not success then
      envim_connect(0, { "envim_acp_error", { error = tostring(error) } })
    end
  end
end

_G.envim_acp_add_file = function(file)
  if _G.envim_acp and file then
    envim_connect(0, { "envim_acp_file_add", vim.fn.fnamemodify(file, ":p") })
  end
end

_G.envim_acp_terminal_start = function(terminalId, command, opts)
  opts.on_stdout = function(_, data)
    if data then
      local output = table.concat(data, "\n")
      if output ~= "" then
        envim_connect(0, { "envim_acp_terminal_output", { terminalId = terminalId, output = output } })
      end
    end
  end
  opts.on_stderr = function(_, data)
    if data then
      local output = table.concat(data, "\n")
      if output ~= "" then
        envim_connect(0, { "envim_acp_terminal_output", { terminalId = terminalId, output = output } })
      end
    end
  end
  opts.on_exit = function(_, exitCode, event)
    local signal = nil
    if event == "signal" then
      signal = tostring(exitCode)
      exitCode = nil
    end
    envim_connect(0, { "envim_acp_terminal_exit", { terminalId = terminalId, exitCode = exitCode, signal = signal } })
  end

  return vim.fn.jobstart(command, opts)
end

vim.cmd([[
  function! EnvimAcpStart(package)
    return v:lua.envim_acp_start(a:package)
  endfunction

  function! EnvimAcpStop()
    return v:lua.envim_acp_stop()
  endfunction

  function! EnvimAcpSend(message)
    return v:lua.envim_acp_send(a:message)
  endfunction

  function! EnvimAcpAddFile(file)
    return v:lua.envim_acp_add_file(a:file)
  endfunction

  function! EnvimAcpTerminalStart(terminalId, command, opts)
    return v:lua.envim_acp_terminal_start(a:terminalId, a:command, a:opts)
  endfunction
]])
