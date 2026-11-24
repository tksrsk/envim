local group = vim.api.nvim_create_augroup("envim", { clear = true })

vim.api.nvim_create_autocmd({ "BufWinEnter" }, {
  group = group,
  pattern = { "http://*", "https://*" },
  callback = function()
    vim.schedule(function()
      envim_connect(0, { "envim_openurl", vim.fn.expand("%:p") })
    end)
  end,
})

vim.api.nvim_create_autocmd({ "BufWinEnter" }, {
  group = group,
  pattern = { "*.ico", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.mp4", "*.webm", "*.pdf", "*.webp", "*.avif", "*.mp3", "*.ogg" },
  callback = function()
    local bufname = vim.api.nvim_buf_get_name(0)

    vim.schedule(function()
      envim_connect(0, { "envim_openurl", "file://" .. bufname })
    end)
  end,
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
