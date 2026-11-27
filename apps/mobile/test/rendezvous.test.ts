import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, loadConfig } from "@ekatva/daemon";
import { generateKeyPair, Ntfy, webSocketTransport } from "@ekatva/link";
import type { LocalRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MemoryKV } from "../src/core/kv";
import { MemoryLines } from "../src/core/logStore";
import type { DeviceApi } from "../src/core/services";
import { type Platform, Session } from "../src/core/session";
import { MemFs } from "./memfs";

/**
 * A tiny ntfy: POST stores, GET …/json?poll=1 lists, and GET …/json (one
 * topic or several, comma-separated) streams, as the real one: an "open"
 * event, then a "message" event for each post to one of its topics.
 */
function fakeNtfy(): Promise<{ server: Server; url: string }> {
  const store: { id: string; topic: string; message: string }[] = [];
  const streams = new Set<{ topics: string[]; res: import("node:http").ServerResponse }>();
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const [, topic, rest] = url.split(/[/?]/);
    if (req.method === "POST") {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const m = { id: String(store.length + 1), topic: topic ?? "", message: b };
        store.push(m);
        res.end("{}");
        for (const s of streams)
          if (s.topics.includes(m.topic))
            s.res.write(
              `${JSON.stringify({ id: m.id, event: "message", topic: m.topic, message: m.message })}\n`,
            );
      });
    } else if (rest === "json" && !url.includes("poll=1")) {
      const s = { topics: (topic ?? "").split(","), res };
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ id: "0", event: "open", topic })}\n`);
      streams.add(s);
      req.on("close", () => streams.delete(s));
    } else if (rest === "json") {
      res.end(
        store
          .filter((m) => m.topic === topic)
          .map((m) => JSON.stringify({ id: m.id, event: "message", message: m.message }))
          .join("\n"),
      );
    } else res.writeHead(404).end();
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    ),
  );
}

describe("finding the laptop from elsewhere", () => {
  let root: string;
  let daemon: Daemon;
  let ntfy: { server: Server; url: string };
  let phone: Session;
  let ws: ReturnType<typeof createWSClient>;
  let local: ReturnType<typeof createTRPCClient<LocalRouter>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ekatva-rv-"));
    process.env.HOME = join(root, "home");
    await fs.mkdir(process.env.HOME);
    ntfy = await fakeNtfy();
    const config = loadConfig(join(root, "none.toml"));
    config.name = "ace";
    config.tunnel.server = ntfy.url;
    daemon = new Daemon({
      config,
      key: generateKeyPair(),
      stateDir: join(root, "home/.local/state/ekatva"),
      configDir: join(root, "home/.config/ekatva"),
      undoDir: join(root, "home/.local/share/ekatva/undo"),
      socketPath: join(root, "ekatva.sock"),
      port: 0,
      host: "127.0.0.1",
      beacon: false,
      checkFirewall: false,
      desktopNotifications: false,
      lan: (port) => [`127.0.0.1:${port}`],
      rendezvousEveryMs: 300,
      // No real tunnel in a test: cloudflared "isn't installed", so answers carry the LAN only.
      tunnelSpawner: () => {
        const child = new EventEmitter() as EventEmitter & { kill: () => void };
        child.kill = () => undefined;
        setTimeout(() => child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })), 1);
        return child as never;
      },
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
      ntfy: new Ntfy(ntfy.url),
    };
    phone = await Session.create(p);
    ws = createWSClient({
      url: `ws+unix://${join(root, "ekatva.sock")}:/`,
      WebSocket: WebSocket as never,
    });
    local = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
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
    ntfy.server.closeAllConnections();
    ntfy.server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("asks the pair's mailbox when the old address is dead, and reconnects", async () => {
    expect(phone.link.state.status).toBe("online");
    const key = daemon.id;
    // The laptop "moved": the address the phone knows answers no more.
    phone.link.stop();
    await phone.laptops.update(key, { lan: ["127.0.0.1:9"], url: null });
    for (let i = 0; i < 50 && phone.link.state.status === "online"; i++)
      await new Promise((r) => setTimeout(r, 20));
    phone.link.start();
    for (let i = 0; i < 150 && phone.link.state.status !== "online"; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(phone.link.state).toMatchObject({ status: "online", via: "lan" });
    expect(phone.laptops.get(key)?.lan).toEqual([`127.0.0.1:${daemon.port}`]);
  }, 30_000);

  it("learns the laptop's route while linked (its tunnel's state too)", async () => {
    for (let i = 0; i < 100 && !phone.laptops.get(daemon.id)?.away; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(phone.laptops.get(daemon.id)?.away).toMatchObject({ kind: "cloudflared" });
    expect((await local.admin.link.route.query()).lan).toEqual([`127.0.0.1:${daemon.port}`]);
  });

  it("a paired laptop's code reconnects the phone: no emoji, no pairing again", async () => {
    const key = daemon.id;
    phone.link.stop();
    await phone.laptops.update(key, { lan: ["127.0.0.1:9"], url: null });
    let asked = false;
    const sub = local.admin.pair.pending.subscribe(undefined, {
      onData: (l) => {
        if (l.length) asked = true;
      },
    });
    const offer = await local.admin.pair.start.mutate({ away: false });
    let sas = false;
    const laptop = await phone.link.pair(offer.uri, () => {
      sas = true;
    });
    sub.unsubscribe();
    expect(laptop.key).toBe(key);
    expect(phone.link.state).toMatchObject({ status: "online", via: "lan" });
    expect(sas).toBe(false);
    expect(asked).toBe(false);
    expect(phone.laptops.get(key)?.lan[0]).toBe(`127.0.0.1:${daemon.port}`);
  }, 20_000);
});
