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

/** A tiny ntfy: POST stores, GET …/json lists. */
function fakeNtfy(): Promise<{ server: Server; url: string }> {
  const store: { id: string; topic: string; message: string }[] = [];
  const server = createServer((req, res) => {
    const [, topic, rest] = (req.url ?? "").split(/[/?]/);
    if (req.method === "POST") {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        store.push({ id: String(store.length + 1), topic: topic ?? "", message: b });
        res.end("{}");
      });
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

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ekatva-rv-"));
    process.env.HOME = join(root, "home");
    await fs.mkdir(process.env.HOME);
    ntfy = await fakeNtfy();
    const config = loadConfig(join(root, "none.toml"));
    config.name = "ace";
    config.tunnel.server = ntfy.url; // cloudflared isn't installed here: the answer carries the LAN only
    daemon = new Daemon({
      config,
      key: generateKeyPair(),
      stateDir: join(root, "home/.local/state/ekatva"),
      configDir: join(root, "home/.config/ekatva"),
      undoDir: join(root, "home/.local/share/ekatva/undo"),
      socketPath: join(root, "ekatva.sock"),
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      lan: (port) => [`127.0.0.1:${port}`],
      rendezvousEveryMs: 300,
      caffeineHost: {
        run: async () => ({ code: 0, out: "" }),
        hold: () => ({ stop() {}, onExit() {} }),
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
    phone = await Session.create(p, "correct horse battery 9!", 2 ** 10);
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
});
