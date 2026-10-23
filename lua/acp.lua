_G.envim_acp_binary_support = function()
  local uname = vim.loop.os_uname()
  local os = ({ Darwin = "darwin", Linux = "linux", Windows_NT = "windows" })[uname.sysname]
  local arch = ({ x86_64 = "x86_64", AMD64 = "x86_64", aarch64 = "aarch64", arm64 = "aarch64", ARM64 = "aarch64" })[uname.machine]

  return {
    npx = vim.fn.executable("npx") == 1,
    uvx = vim.fn.executable("uvx") == 1,
    platform = os and arch and (os .. "-" .. arch) or nil,
    tar = vim.fn.executable("tar") == 1,
    unzip = vim.fn.executable("unzip") == 1
  }
end

local function envim_acp_download(pkg, name, version)
  local command = pkg.command
  local cache = vim.fn.stdpath("cache") .. "/envim/acp/" .. vim.fn.sha256(name or pkg.command[1])
  local expected_version = version or pkg.archive
  local version_name = version and version:gsub("[^%w._-]", "_") or vim.fn.sha256(expected_version)
  local version_file = cache .. "/" .. version_name
  local relative = pkg.command[1]:gsub("^%.[/\\]", ""):gsub("\\", "/")
  local executable = cache .. "/" .. relative

  if vim.fn.filereadable(version_file) ~= 1 or vim.fn.filereadable(executable) ~= 1 then
    vim.fn.delete(cache, "rf")
    vim.fn.mkdir(cache, "p")
    local archive = cache .. "/download"
    local done, request_error = false, nil
    local request = vim.net.request(pkg.archive, { outpath = archive }, function(error)
      request_error = error
      done = true
    end)

    if not vim.wait(300000, function() return done end, 20) then
      request:close()
      request_error = "download timed out"
    end
    if request_error then
      vim.fn.delete(archive)
      envim_connect(0, { "envim_acp_error", { error = tostring(request_error) } })
      return nil
    end

    local path = pkg.archive:gsub("[?#].*$", ""):lower()
    local output = ""
    if path:match("%.zip$") then
      output = vim.fn.system({ "unzip", "-q", archive, "-d", cache })
    elseif path:match("%.tar%.[a-z0-9]+$") or path:match("%.tgz$") then
      output = vim.fn.system({ "tar", "-xf", archive, "-C", cache })
    else
      vim.fn.mkdir(vim.fn.fnamemodify(executable, ":h"), "p")
      if vim.fn.rename(archive, executable) ~= 0 then
        output = "failed to install downloaded binary"
      end
    end
    vim.fn.delete(archive)

    if output ~= "" then
      envim_connect(0, { "envim_acp_error", { error = output } })
      return nil
    end
    if vim.fn.has("win32") == 0 then
      vim.fn.setfperm(executable, "rwxr-xr-x")
    end
    vim.fn.writefile({}, version_file)
  end

  return vim.list_extend({ executable }, vim.list_slice(command, 2))
end

_G.envim_acp_start = function(agent)
  local pkg, auth = agent.package, agent.auth or {}

  if _G.envim_acp then
    return "initialized"
  end

  if not pkg or type(pkg.command) ~= "table" or #pkg.command == 0 then
    return nil
  end

  local command = pkg.archive and envim_acp_download(pkg, agent.name, agent.version) or pkg.command
  if not command then
    return nil
  end

  vim.list_extend(command, auth.args or {})
  local opts = {
    env = (pkg.env or auth.env) and vim.tbl_extend("force", pkg.env or {}, auth.env or {}),
    term = agent.auth ~= nil,
    on_exit = function(_, code)
      _G.envim_acp = nil
      envim_connect(0, { "envim_acp_exited", code })
    end
  }
  if not agent.auth then
    opts.on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line and line ~= "" then
          envim_connect(0, { "envim_acp_stdout", line })
        end
      end
    end
  end

  if agent.auth then vim.cmd.tabnew() end

  local success, result = pcall(vim.fn.jobstart, command, opts)

  if success and result > 0 then
    _G.envim_acp = result
    if agent.auth then vim.cmd.startinsert() end
    return "executed"
  else
    _G.envim_acp = nil
    if agent.auth then
      local buffer = vim.api.nvim_get_current_buf()
      vim.cmd.tabclose()
      pcall(vim.api.nvim_buf_delete, buffer, { force = true })
    end
    return nil
  end
end

_G.envim_acp_stop = function()
  if _G.envim_acp then
    vim.fn.jobstop(_G.envim_acp)
    return vim.fn.jobwait({ _G.envim_acp })[1]
  end
  return 0
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

local acp_read_ticks = {}

local function acp_find_buf(file)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_buf_get_name(buf) == file then
      return buf
    end
  end
end

_G.envim_acp_read_text_file = function(path, line, limit)
  local file = vim.fn.fnamemodify(path, ":p")
  local start = math.max(line - 1, 0)
  local buf = acp_find_buf(file)

  if buf then
    acp_read_ticks[file] = { buf = buf, tick = vim.api.nvim_buf_get_changedtick(buf) }
    return vim.api.nvim_buf_get_lines(buf, start, limit < 0 and -1 or start + limit, false)
  end

  if vim.fn.filereadable(file) == 0 then
    return nil
  end

  local lines = limit < 0 and vim.fn.readfile(file) or vim.fn.readfile(file, "", start + limit)

  return vim.list_slice(lines, start + 1)
end

_G.envim_acp_write_text_file = function(path, content)
  local file = vim.fn.fnamemodify(path, ":p")
  local lines = vim.split(content, "\n", { plain = true })
  local eol = #lines > 1 and lines[#lines] == ""

  if eol then
    table.remove(lines)
  end

  local buf = acp_find_buf(file)

  if buf then
    local read = acp_read_ticks[file]
    local changed = vim.bo[buf].modified

    if read and read.buf == buf then
      changed = read.tick ~= vim.api.nvim_buf_get_changedtick(buf)
    end

    if changed then
      return "The file has been modified in the editor since it was last read. Read it again before writing."
    end

    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)

    local success, error = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("silent noautocmd write") end)

    acp_read_ticks[file] = { buf = buf, tick = vim.api.nvim_buf_get_changedtick(buf) }

    return not success and tostring(error) or nil
  end

  local success, result = pcall(function()
    vim.fn.mkdir(vim.fn.fnamemodify(file, ":h"), "p")
    return vim.fn.writefile(lines, file, eol and "" or "b")
  end)

  return not (success and result == 0) and ("Failed to write file: " .. path) or nil
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
  function! EnvimAcpBinarySupport()
    return v:lua.envim_acp_binary_support()
  endfunction

  function! EnvimAcpStart(agent)
    return v:lua.envim_acp_start(a:agent)
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

  function! EnvimAcpReadTextFile(path, line, limit)
    return v:lua.envim_acp_read_text_file(a:path, a:line, a:limit)
  endfunction

  function! EnvimAcpWriteTextFile(path, content)
    return v:lua.envim_acp_write_text_file(a:path, a:content)
  endfunction

  function! EnvimAcpTerminalStart(terminalId, command, opts)
    return v:lua.envim_acp_terminal_start(a:terminalId, a:command, a:opts)
  endfunction
]])
