_G.envim_mcp_tunnel_start = function()
  if not vim.base64 then
    return nil
  end

  if _G.envim_mcp_tunnel then
    return _G.envim_mcp_tunnel.server:getsockname().port
  end

  local uv = vim.uv or vim.loop
  local server = uv.new_tcp()
  local tunnel = { server = server, clients = {}, next_id = 0 }

  server:bind("127.0.0.1", 0)
  server:listen(128, vim.schedule_wrap(function(error)
    if error then
      return envim_connect(0, { "envim_mcp_tunnel_error", "", error })
    end

    local client = uv.new_tcp()
    server:accept(client)
    tunnel.next_id = tunnel.next_id + 1

    local connection_id = tostring(tunnel.next_id)
    tunnel.clients[connection_id] = client
    envim_connect(0, { "envim_mcp_tunnel_open", connection_id })

    client:read_start(vim.schedule_wrap(function(read_error, data)
      if read_error then
        envim_connect(0, { "envim_mcp_tunnel_error", connection_id, read_error })
      end

      if data then
        envim_connect(0, { "envim_mcp_tunnel_data", connection_id, vim.base64.encode(data) })
      else
        tunnel.clients[connection_id] = nil
        client:close()
        envim_connect(0, { "envim_mcp_tunnel_close", connection_id })
      end
    end))
  end))

  _G.envim_mcp_tunnel = tunnel

  return server:getsockname().port
end

_G.envim_mcp_tunnel_write = function(connection_id, data)
  local client = _G.envim_mcp_tunnel and _G.envim_mcp_tunnel.clients[connection_id]

  if client and data then
    client:write(vim.base64.decode(data))
  end
end

_G.envim_mcp_tunnel_close = function(connection_id)
  local tunnel = _G.envim_mcp_tunnel
  local client = tunnel and tunnel.clients[connection_id]

  if client then
    tunnel.clients[connection_id] = nil
    client:read_stop()
    client:close()
  end
end

_G.envim_mcp_tunnel_stop = function()
  local tunnel = _G.envim_mcp_tunnel

  if tunnel then
    for connection_id, client in pairs(tunnel.clients) do
      tunnel.clients[connection_id] = nil
      client:read_stop()
      client:close()
    end

    tunnel.server:close()
    _G.envim_mcp_tunnel = nil
  end
end

vim.cmd([[
  function! EnvimMcpTunnelStart()
    return v:lua.envim_mcp_tunnel_start()
  endfunction

  function! EnvimMcpTunnelWrite(connectionId, data)
    return v:lua.envim_mcp_tunnel_write(a:connectionId, a:data)
  endfunction

  function! EnvimMcpTunnelClose(connectionId)
    return v:lua.envim_mcp_tunnel_close(a:connectionId)
  endfunction

  function! EnvimMcpTunnelStop()
    return v:lua.envim_mcp_tunnel_stop()
  endfunction
]])
