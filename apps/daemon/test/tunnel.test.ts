import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { ANNOUNCE, generateKeyPair, mailbox, Ntfy, nonce } from "@ekatva/link";
import { describe, expect, it, vi } from "vitest";
import { Rendezvous } from "../src/services/rendezvous.js";
import { Tunnel } from "../src/services/tunnel.js";

/** A pretend cloudflared: prints its URL to stderr like the real one. */
function fakeSpawner(lines: string[], calls: string[][]) {
  return (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", 0);
    setTimeout(() => {
      for (const l of lines) child.stderr.emit("data", Buffer.from(l));
    }, 5);
    return child as never;
  };
}

describe("tunnel", () => {
  it("starts cloudflared on demand, reads its URL, and reuses it", async () => {
    const calls: string[][] = [];
    const t = new Tunnel(
      "cloudflared",
      () => 47100,
      undefined,
      10,
      fakeSpawner(
        ["INF Starting tunnel", "INF |  https://quiet-river-28.trycloudflare.com  |"],
        calls,
      ),
    );
    expect(await t.start()).toEqual({ url: "wss://quiet-river-28.trycloudflare.com", lan: [] });
    expect(calls[0]).toEqual([
      "cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:47100",
    ]);
    expect((await t.start()).url).toBe("wss://quiet-river-28.trycloudflare.com");
    expect(calls).toHaveLength(1);
    t.stop();
    expect(t.running).toBe(false);
  });

  it("reads ngrok's JSON log", async () => {
    const t = new Tunnel(
      "ngrok",
      () => 47100,
      undefined,
      10,
      fakeSpawner(
        ['{"lvl":"info","msg":"started tunnel","url":"https://ab12.ngrok-free.app"}'],
        [],
      ),
    );
    expect((await t.start()).url).toBe("wss://ab12.ngrok-free.app");
    t.stop();
  });

  it("gives up cleanly when nothing prints a URL", async () => {
    const t = new Tunnel(
      "cloudflared",
      () => 47100,
      undefined,
      10,
      fakeSpawner(["ERR failed"], []),
    );
    expect(await t.start(100)).toEqual({ url: null, lan: [] });
    await expect(new Tunnel("none", () => 1).start()).resolves.toEqual({ url: null, lan: [] });
  });
});

describe("tunnel kept up", () => {
  /** A cloudflared that gives a new URL each start and can be killed from outside. */
  function dying() {
    const kids: (EventEmitter & { kill: () => void })[] = [];
    let n = 0;
    const spawner = (_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => child.emit("exit", 0);
      const url = `https://river-${++n}.trycloudflare.com`;
      setTimeout(() => child.stderr.emit("data", Buffer.from(`INF |  ${url}  |`)), 5);
      kids.push(child);
      return child as never;
    };
    return { kids, spawner };
  }

  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("opens at once, comes back by itself under a new URL, and says each one", async () => {
    const f = dying();
    const t = new Tunnel("cloudflared", () => 47100, undefined, 10, f.spawner, 20);
    const seen: (string | null)[] = [];
    t.onChange((i) => seen.push(i.url));
    t.keep(true);
    await until(() => t.info().state === "up");
    expect(t.info()).toMatchObject({
      state: "up",
      always: true,
      url: "wss://river-1.trycloudflare.com",
    });
    // cloudflared dies: it is opened again, with its new URL.
    f.kids[0]?.emit("exit", 1);
    expect(t.info().state).toBe("starting");
    await until(() => t.info().url === "wss://river-2.trycloudflare.com");
    expect(t.info().state).toBe("up");
    expect(seen.filter(Boolean)).toEqual([
      "wss://river-1.trycloudflare.com",
      "wss://river-2.trycloudflare.com",
    ]);
    // Back to on demand: no restarting after that.
    t.stop();
    expect(t.info()).toMatchObject({ state: "off", always: false, url: null });
    expect(f.kids).toHaveLength(2);
  });

  it("reopens a tunnel whose program runs but no longer reaches the laptop", async () => {
    const f = dying();
    // river-1 dies quietly (cloudflared lost Cloudflare after a network drop).
    const asked: string[] = [];
    const probe = async (url: string) => {
      asked.push(url);
      return !url.includes("river-1");
    };
    const t = new Tunnel("cloudflared", () => 47100, undefined, 10, f.spawner, 20, probe, 15);
    const seen: (string | null)[] = [];
    t.onChange((i) => seen.push(i.url));
    t.keep(true);
    await until(() => t.info().url === "wss://river-2.trycloudflare.com");
    expect(t.info().state).toBe("up");
    // Two misses in a row, not one, before giving up on it.
    expect(asked.filter((u) => u.includes("river-1")).length).toBeGreaterThanOrEqual(2);
    expect(seen.filter(Boolean)).toEqual([
      "wss://river-1.trycloudflare.com",
      "wss://river-2.trycloudflare.com",
    ]);
    t.stop();
  });

  it("checks a tunnel it hasn't heard from before sending a phone to it", async () => {
    const f = dying();
    let alive = true;
    const t = new Tunnel(
      "cloudflared",
      () => 47100,
      undefined,
      10,
      f.spawner,
      20,
      async () => alive,
      60_000,
    );
    expect((await t.start()).url).toBe("wss://river-1.trycloudflare.com");
    // Fresh: handed out without asking. A minute later, it's dead: a new one.
    alive = false;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    const reach = t.start();
    alive = true;
    expect((await reach).url).toBe("wss://river-2.trycloudflare.com");
    expect(f.kids).toHaveLength(2);
    clock.mockRestore();
    t.stop();
  });

  it("says when the program isn't installed", async () => {
    const t = new Tunnel(
      "cloudflared",
      () => 47100,
      undefined,
      10,
      () => {
        const child = new EventEmitter() as EventEmitter & { kill: () => void };
        child.kill = () => undefined;
        setTimeout(
          () => child.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" })),
          5,
        );
        return child as never;
      },
    );
    t.keep(true);
    await until(() => t.info().state === "missing");
    expect(t.info()).toMatchObject({ state: "missing", problem: "cloudflared isn't installed" });
    t.stop();
  });
});

describe("rendezvous on the laptop", () => {
  it("answers a phone's 'where are you?' with the tunnel's URL, sealed", async () => {
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
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const ntfy = new Ntfy(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const laptop = generateKeyPair();
    const phone = generateKeyPair();
    const tunnel = new Tunnel(
      "cloudflared",
      () => 47100,
      undefined,
      10,
      fakeSpawner(["https://calm-sea.trycloudflare.com"], []),
    );
    const rv = new Rendezvous(
      laptop,
      () => [{ key: Buffer.from(phone.publicKey).toString("base64url"), name: "Pixel 8" }],
      tunnel,
      () => ["192.168.1.7:47100"],
      ntfy,
    );
    const mb = mailbox(phone, laptop.publicKey);
    const n = nonce();
    await ntfy.publish(mb.topic, mb.seal({ t: "where", at: Date.now(), n }));
    await rv.check();
    const answers = (await ntfy.poll(mb.topic))
      .map((m) => mb.open(m.message))
      .filter((m) => m?.t === "here");
    expect(answers).toEqual([
      {
        t: "here",
        at: expect.any(Number),
        url: "wss://calm-sea.trycloudflare.com",
        lan: ["192.168.1.7:47100"],
        n,
      },
    ]);
    // A new URL is said unasked, to every paired phone's mailbox.
    await rv.announce("wss://new-sea.trycloudflare.com");
    const told = (await ntfy.poll(mb.topic))
      .map((m) => mb.open(m.message))
      .filter((m) => m?.t === "here" && m.n === ANNOUNCE);
    expect(told).toEqual([expect.objectContaining({ url: "wss://new-sea.trycloudflare.com" })]);
    store.splice(store.length - 1, 1);
    // The same question isn't answered twice.
    await rv.check();
    expect((await ntfy.poll(mb.topic)).length).toBe(2);
    tunnel.stop();
    server.close();
  });
});
