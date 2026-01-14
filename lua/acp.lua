local function parse_command_args(command_str)
  if not command_str or command_str == "" then
    return {}
  end

  local command = {}
  local in_quotes = false
  local current = ""
  local quote_char = nil

  for i = 1, #command_str do
    local char = command_str:sub(i, i)

    if char == '"' or char == "'" then
      if in_quotes and quote_char == char then
        in_quotes = false
        quote_char = nil
      elseif not in_quotes then
        in_quotes = true
        quote_char = char
      end
    elseif char == ' ' and not in_quotes then
      if current ~= "" then
        table.insert(command, current)
        current = ""
      end
    else
      current = current .. char
    end
  end

  if current ~= "" then
    table.insert(command, current)
  end

  return command
end

_G.envim_acp_start = function(command_str)
  local command = parse_command_args(command_str)

  if _G.envim_acp then
    return "initialized"
  end

  _G.envim_acp = vim.fn.jobstart(command, {
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line and line ~= "" then
          envim_connect(0, { "envim_acp_stdout", line })
        end
      end
    end,
    on_exit = function(_, code, signal)
      _G.envim_acp = nil
      envim_connect(0, { "envim_acp_exited", { code = code, signal = signal } })
    end
  })

  if _G.envim_acp <= 0 then
    envim_connect(0, { "envim_acp_error", { error = "Failed to start acp job" } })
    return nil
  end

  return "executed"
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

vim.cmd([[
  function! EnvimAcpStart(command_str)
    return v:lua.envim_acp_start(a:command_str)
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
]])
