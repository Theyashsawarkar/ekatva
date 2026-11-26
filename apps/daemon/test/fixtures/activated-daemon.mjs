// A daemon as systemd starts it from ekatva-mcp.socket: the MCP listener
// arrives at fd 3 with LISTEN_PID/LISTEN_FDS (pranali.test.ts passes it the
// way systemd does). Made-up state in ROOT; fake hosts; nothing real touched.
// Prints "ready <fd>" once serving, and stops (draining) on SIGTERM.
import { join } from "node:path";
import { generateKeyPair } from "@ekatva/link";
import { loadConfig } from "../../dist/config.js";
import { Daemon } from "../../dist/daemon.js";
import { activatedFd, forgetActivation } from "../../dist/mcpSocket.js";

const root = process.env.ROOT;
const fd = activatedFd(process.env, process.pid);
forgetActivation(process.env);
const config = loadConfig(join(root, "none.toml"));
config.name = "ace";
const host = {
  run: async () => ({ code: 0, out: "" }),
  hold: () => ({ stop: async () => undefined, onExit: () => undefined }),
  lock: async () => undefined,
  lidClosed: () => null,
  battery: () => null,
  now: () => Date.now(),
};
const d = new Daemon({
  config,
  key: generateKeyPair(),
  stateDir: join(root, "home/.local/state/ekatva"),
  configDir: join(root, "home/.config/ekatva"),
  undoDir: join(root, "home/.local/share/ekatva/undo"),
  socketPath: join(root, "ekatva.sock"),
  mcpSocketPath: join(root, "never-bound", "mcp.sock"),
  ...(fd !== null ? { mcpListenFd: fd } : {}),
  port: 0,
  host: "127.0.0.1",
  beacon: false,
  checkFirewall: false,
  desktopNotifications: false,
  rendezvous: false,
  keepaliveMs: 0,
  jyotiHost: host,
  mediaHost: { run: async () => ({ code: 127, out: "" }), art: async () => null, now: Date.now },
  approve: async () => false,
  log: (m) => process.stderr.write(`${m}\n`),
});
await d.start();
process.stdout.write(`ready ${fd} ${process.env.LISTEN_FDS ?? "-"}\n`);
process.on("SIGTERM", () => void d.stop().then(() => process.exit(0)));
