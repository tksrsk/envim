local group = vim.api.nvim_create_augroup("envim", { clear = true })

vim.api.nvim_create_autocmd({ "BufWinEnter" }, {
  group = group,
  pattern = { "http://*", "https://*" },
  callback = function()
    vim.schedule(function()
      local path = vim.fn.expand("%:p")

      envim_connect(0, { "envim_openurl", path, "vnew" })
    end)
  end,
})

vim.api.nvim_create_autocmd({ "BufWinEnter" }, {
  group = group,
  pattern = { "*.ico", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.mp4", "*.webm", "*.pdf" },
  callback = function()
    vim.schedule(function()
      local path = vim.fn.expand("%:p")
      local ext = vim.fn.expand("%:e")
      local content = vim.fn.readblob(path)

      content = ext == "svg" and content or vim.fn.blob2list(content)

      envim_connect(0, { "envim_preview", content, ext })
    end)
  end,
})

vim.api.nvim_create_autocmd({ "WinNew", "BufWinEnter" }, {
  group = group,
  pattern = { "envim://browser" },
  callback = function()
    local winid = vim.fn.win_getid()

    vim.bo.filetype = "browser"
    vim.bo.buftype = "nofile"
    vim.bo.bufhidden = "wipe"
    vim.bo.buflisted = false
    vim.schedule(function() envim_connect(0, { "envim_preview_toggle", winid, true, vim.w.envim_browser_src or "" }) end)
  end,
})

vim.api.nvim_create_autocmd({ "BufLeave" }, {
  group = group,
  pattern = { "envim://browser" },
  callback = function()
    local prev = vim.fn.win_getid()

    vim.api.nvim_create_autocmd({ "BufEnter" }, {
      group = group,
      once = true,
      callback = function()
        local curr = vim.fn.win_getid()

        if prev == curr then
          vim.w.envim_browser_src = nil
          vim.schedule(function () envim_connect(0, { "envim_preview_toggle", curr, false, "" }) end)
        end
      end,
    })
  end,
})

vim.api.nvim_create_autocmd({ "DirChanged" }, {
  group = group,
  callback = function() envim_connect(0, { "envim_dirchanged", vim.fn.getcwd() }) end,
})

vim.api.nvim_create_autocmd({ "OptionSet" }, {
  group = group,
  pattern = { "background" },
  callback = function()
    vim.cmd([[ mode ]])
    envim_connect(0, { "envim_setbackground", vim.o.background })
  end,
})

vim.api.nvim_create_autocmd({ "TabLeave" }, {
  group = group,
  callback = function() return vim.api.nvim_win_get_config(0).external and vim.cmd([[wincmd j]]) end,
})

vim.api.nvim_create_autocmd({ "UILeave" }, {
  group = group,
  callback = function() return vim.api.nvim_del_augroup_by_id(group) end,
})
