_G.envim_connect = function (sync, args)
  local fname = sync > 0 and "rpcrequest" or "rpcnotify"

  table.insert(args, 1, vim.g.envim_id)

  return vim.api.nvim_call_function(fname, args)
end

_G.envim_input = (function ()
  local cache = {}

  return function (prompt, default, completion)
    local old = {}
    local history = cache[prompt] or {}

    _G.envim_completion = function () return history end

    for pos = 1, vim.fn.histnr("input") do
      table.insert(old, vim.fn.histget("input", pos))
    end

    vim.fn.histdel("input")

    local input = vim.fn.input(string.format("%s: ", prompt), default or "", completion or "customlist,v:lua.envim_completion")

    input = vim.fn.trim(input or "")
    if input ~= "" then
      local tmp = {}

      for _, val in ipairs(history) do
        if val ~= input then table.insert(tmp, val) end
      end
      table.insert(tmp, 1, input)

      history = tmp
    end

    vim.fn.histdel("input")
    for _, val in ipairs(old) do
      vim.fn.histadd("input", val)
    end

    _G.envim_completion = nil
    cache[prompt] = history

    return input
  end
end)()

vim.cmd([[
  function! EnvimConnect(sync, ...)
    return v:lua.envim_connect(a:sync, a:000)
  endfunction

  function! EnvimInput(prompt, ...)
    return v:lua.envim_input(a:prompt, get(a:, 1, v:false), get(a:, 2, v:false))
  endfunction

  function! EnvimReadBlob(path)
    return blob2list(readblob(a:path))
  endfunction
]])
