import { createSocket } from "node:dgram";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, loadConfig } from "@ekatva/daemon";
import { generateKeyPair, webSocketTransport } from "@ekatva/link";
import type { LocalRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MemoryKV } from "../src/core/kv";
import { MemoryLines } from "../src/core/logStore";
import type { DeviceApi } from "../src/core/services";
import { type Platform, Session } from "../src/core/session";
import { MemFs } from "./memfs";

/** A free UDP port for the phone's beacon listener. */
function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
}

async function until(ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

describe("finding the laptop on the same network", () => {
  let root: string;
  let daemon: Daemon;
  let phone: Session;
  let ws: ReturnType<typeof createWSClient>;

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ekatva-bc-"));
    process.env.HOME = join(root, "home");
    await fs.mkdir(process.env.HOME);
    const beaconPort = await freePort();
    const config = loadConfig(join(root, "none.toml"));
    config.name = "ace";
    daemon = new Daemon({
      config,
      key: generateKeyPair(),
      stateDir: join(root, "home/.local/state/ekatva"),
      configDir: join(root, "home/.config/ekatva"),
      undoDir: join(root, "home/.local/share/ekatva/undo"),
      socketPath: join(root, "ekatva.sock"),
      port: 0,
      host: "127.0.0.1",
      beacon: true,
      beaconTargets: () => ["127.0.0.1"],
      beaconPort,
      beaconEveryMs: 200,
      checkFirewall: false,
      desktopNotifications: false,
      rendezvous: false,
      lan: (port) => [`127.0.0.1:${port}`],
      jyotiHost: {
        run: async () => ({ code: 0, out: "" }),
        hold: () => ({ stop: async () => undefined, onExit() {} }),
        lock: async () => undefined,
        lidClosed: () => null,
        battery: () => null,
        now: Date.now,
      },
      log: () => undefined,
    });
    await daemon.start();
    const kv = new MemoryKV();
    const lines = new Map<string, MemoryLines>();
    const device = {
      name: "Pixel 8",
      battery: async () => null,
      signal: async () => null,
      locked: async () => null,
      ring: async () => {},
      stopRinging: async () => {},
      ringing: () => false,
      notifications: null,
      keepAwake: async () => {},
      awake: () => false,
      clipboardGet: async () => "",
      clipboardSet: async () => {},
      lock: null,
      calls: null,
      sms: null,
    } as DeviceApi;
    const p: Platform = {
      kv,
      lines: (n) => {
        const l = lines.get(n) ?? new MemoryLines();
        lines.set(n, l);
        return l;
      },
      fs: new MemFs(),
      roots: async () => ["/sd"],
      undoDir: "/app/undo",
      device,
      open: (url, ms) =>
        new Promise((resolve, reject) => {
          const s = new WebSocket(url);
          const t = setTimeout(() => {
            s.terminate();
            reject(new Error("timed out"));
          }, ms);
          s.once("open", () => {
            clearTimeout(t);
            resolve(webSocketTransport(s as never));
          });
          s.once("error", (e) => {
            clearTimeout(t);
            reject(e);
          });
        }),
      info: {},
      beacons: (cb) => {
        const rx = createSocket({ type: "udp4", reuseAddr: true });
        rx.on("message", (m, r) => cb(r.address, new Uint8Array(m)));
        rx.bind(beaconPort, "127.0.0.1");
        return () => rx.close();
      },
    };
    phone = await Session.create(p);
    ws = createWSClient({
      url: `ws+unix://${join(root, "ekatva.sock")}:/`,
      WebSocket: WebSocket as never,
    });
    const local = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
    const offer = await local.admin.pair.start.mutate({ away: false });
    const sub = local.admin.pair.pending.subscribe(undefined, {
      onData: (l) => {
        if (l[0]) {
          sub.unsubscribe();
          void local.admin.pair.confirm.mutate({ id: l[0].id, accept: true, grants: [] });
        }
      },
    });
    await phone.link.pair(offer.uri, () => undefined);
  });

  afterAll(async () => {
    phone.link.stop();
    ws.close();
    await daemon.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("goes where the beacon says when the saved address is dead, with no internet", async () => {
    expect(phone.link.state.status).toBe("online");
    const key = daemon.id;
    phone.link.stop();
    await until(() => phone.link.state.status !== "online", 2000);
    await phone.laptops.update(key, { lan: ["127.0.0.1:9"], url: null });
    phone.link.start();
    await until(() => phone.link.state.status === "online", 10_000);
    expect(phone.link.state).toMatchObject({ status: "online", via: "lan" });
    expect(phone.laptops.get(key)?.lan[0]).toBe(`127.0.0.1:${daemon.port}`);
  }, 20_000);

  it("moves from the tunnel to the direct link when the laptop is heard nearby", async () => {
    const key = daemon.id;
    phone.link.stop();
    await until(() => phone.link.state.status !== "online", 2000);
    // Reachable only "through the tunnel" now (here the same port, as a wss-less URL).
    await phone.laptops.update(key, { lan: [], url: `ws://127.0.0.1:${daemon.port}` });
    phone.link.start();
    await until(() => phone.link.state.status === "online", 10_000);
    const seen: string[] = [];
    const off = phone.link.subscribe((s) => {
      if (s.status === "online") seen.push(s.via);
    });
    await until(() => seen.includes("lan"), 15_000);
    off();
    expect(phone.link.state).toMatchObject({ status: "online", via: "lan" });
    // And the link still works after the move.
    expect((await phone.link.client?.status.query())?.name).toBe("ace");
  }, 30_000);
});
