_G.envim_connect = function (sync, args)
  local fname = sync > 0 and "rpcrequest" or "rpcnotify"

  table.insert(args, 1, vim.g.envim_id)

  return vim.api.nvim_call_function(fname, args)
end

local open_ns = vim.api.nvim_create_namespace("envim_open")

_G.envim_open_file = function (src)
  if src == "" then return false end

  local is_uri = src:sub(1, 7) == "file://"
  local filename = is_uri and vim.uri_to_fname(src) or vim.fn.fnamemodify(src, ":p")
  local line = is_uri and tonumber(src:match("#L(%d+)$"))

  if vim.fn.getftype(filename) == "" then return false end

  vim.cmd.buffer(vim.fn.bufadd(filename))
  vim.bo.buflisted = true

  if line and line > 0 then
    local buf = vim.api.nvim_get_current_buf()

    vim.api.nvim_win_set_cursor(0, { math.min(line, vim.api.nvim_buf_line_count(buf)), 0 })
    vim.cmd("normal! zz")
    vim.api.nvim_buf_clear_namespace(buf, open_ns, 0, -1)
    vim.api.nvim_buf_set_extmark(buf, open_ns, vim.fn.line(".") - 1, 0, { line_hl_group = "Visual" })
    vim.defer_fn(function()
      if vim.api.nvim_buf_is_valid(buf) then
        vim.api.nvim_buf_clear_namespace(buf, open_ns, 0, -1)
      end
    end, 1500)
  end

  return true
end

vim.cmd([[
  function! EnvimConnect(sync, ...)
    return v:lua.envim_connect(a:sync, a:000)
  endfunction

  function! EnvimOpenFile(src)
    return v:lua.envim_open_file(a:src)
  endfunction

  function! EnvimReadBlob(path)
    return blob2list(readblob(a:path))
  endfunction
]])
