import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { generateKeyPair, mailbox, Ntfy, nonce } from "@ekatva/link";
import { describe, expect, it } from "vitest";
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
    // The same question isn't answered twice.
    await rv.check();
    expect((await ntfy.poll(mb.topic)).length).toBe(2);
    tunnel.stop();
    server.close();
  });
});
