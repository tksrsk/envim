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

_G.envim_acp_start = function(pkg, name, version)
  if _G.envim_acp then
    return "initialized"
  end

  if not pkg or type(pkg.command) ~= "table" or #pkg.command == 0 then
    return nil
  end

  local command = pkg.archive and envim_acp_download(pkg, name, version) or pkg.command
  if not command then
    return nil
  end

  local success, result = pcall(vim.fn.jobstart, command, {
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
  function! EnvimAcpBinarySupport()
    return v:lua.envim_acp_binary_support()
  endfunction

  function! EnvimAcpStart(package, name, version)
    return v:lua.envim_acp_start(a:package, a:name, a:version)
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
