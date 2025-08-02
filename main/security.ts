import { session, WebContents } from "electron";

session
  .fromPartition("")
  .setPermissionRequestHandler((webContents: WebContents, permission: string, callback) => {
    const parsedUrl = new URL(webContents.getURL())
  })
