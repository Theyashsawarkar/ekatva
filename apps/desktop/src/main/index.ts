/**
 * The window's main process. It does one thing beyond showing the window:
 * relay a MessagePort to the daemon's local socket, so the sandboxed
 * renderer can talk tRPC to the daemon without any Node access.
 */
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, MessageChannelMain, shell } from "electron";
import WebSocket from "ws";

app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.setName("ekatva");

const socketPath = () =>
  join(process.env.XDG_RUNTIME_DIR || join(app.getPath("home"), ".local/state"), "ekatva.sock");

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: "ekatva",
    backgroundColor: "#191724",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links open in the browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  const tab = process.argv.find((a) => a.startsWith("--tab="))?.slice(6);
  const query = tab ? { tab } : undefined;
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${tab ? `?tab=${tab}` : ""}`);
  else
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), query ? { query } : {});
}

/** One socket to the daemon per request, relayed over a MessagePort. */
ipcMain.on("ekatva:connect", (event) => {
  const { port1, port2 } = new MessageChannelMain();
  const ws = new WebSocket(`ws+unix://${socketPath()}:/`);
  const pending: string[] = [];
  ws.on("open", () => {
    port1.postMessage({ t: "open" });
    for (const m of pending.splice(0)) ws.send(m);
  });
  ws.on("message", (data) => port1.postMessage({ t: "message", data: String(data) }));
  ws.on("close", (code, reason) => {
    port1.postMessage({ t: "close", code, reason: String(reason) });
    port1.close();
  });
  ws.on("error", (e) =>
    port1.postMessage({
      t: "error",
      message:
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "the ekatva service isn't running"
          : e.message,
    }),
  );
  port1.on("message", (m) => {
    const msg = m.data as { t: string; data?: string };
    if (msg.t === "send" && typeof msg.data === "string") {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg.data);
      else pending.push(msg.data);
    } else if (msg.t === "close") ws.close();
  });
  port1.start();
  event.sender.postMessage("ekatva:port", null, [port2]);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
