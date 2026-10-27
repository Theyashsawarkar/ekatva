import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/noise.js";
import { mailbox, Ntfy, nonce } from "../src/rendezvous.js";

const laptop = generateKeyPair();
const phone = generateKeyPair();

describe("rendezvous", () => {
  it("both sides derive the same private mailbox; nobody else does", () => {
    const a = mailbox(laptop, phone.publicKey);
    const b = mailbox(phone, laptop.publicKey);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).toMatch(/^ekatva-[\w-]{24}$/);
    const msg = {
      t: "here" as const,
      at: Date.now(),
      url: "wss://quiet-river.trycloudflare.com",
      lan: ["192.168.1.7:47100"],
      n: nonce(),
    };
    expect(b.open(a.seal(msg))).toEqual(msg);
    const stranger = mailbox(generateKeyPair(), laptop.publicKey);
    expect(stranger.topic).not.toBe(a.topic);
    expect(stranger.open(a.seal(msg))).toBeNull();
  });

  it("refuses stale, damaged and malformed messages", () => {
    const a = mailbox(laptop, phone.publicKey);
    const b = mailbox(phone, laptop.publicKey);
    const old = a.seal({ t: "where", at: Date.now() - 11 * 60_000, n: nonce() });
    expect(b.open(old)).toBeNull();
    const sealed = a.seal({ t: "where", at: Date.now(), n: nonce() });
    expect(b.open(`${sealed.slice(0, -2)}AA`)).toBeNull();
    expect(b.open("garbage")).toBeNull();
    // A URL that isn't a plain wss:// one is refused.
    expect(
      b.open(
        a.seal({ t: "here", at: Date.now(), url: "javascript:alert(1)", lan: [], n: nonce() }),
      ),
    ).toBeNull();
  });

  it("talks to an ntfy server", async () => {
    const store: { id: string; message: string; topic: string }[] = [];
    const server = createServer((req, res) => {
      const [, topic, rest] = (req.url ?? "").split(/[/?]/);
      if (req.method === "POST") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          store.push({ id: String(store.length + 1), message: body, topic: topic ?? "" });
          res.end("{}");
        });
        return;
      }
      if (rest === "json") {
        res.end(
          store
            .filter((m) => m.topic === topic)
            .map((m) => JSON.stringify({ id: m.id, event: "message", message: m.message }))
            .join("\n"),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const ntfy = new Ntfy(`http://127.0.0.1:${port}`);
    const a = mailbox(laptop, phone.publicKey);
    const b = mailbox(phone, laptop.publicKey);
    await ntfy.publish(b.topic, b.seal({ t: "where", at: Date.now(), n: nonce() }));
    const got = await ntfy.poll(a.topic);
    expect(got.map((m) => a.open(m.message)?.t)).toEqual(["where"]);
    server.close();
  });

  it("gives up on a server that never answers", async () => {
    // Accepts the request and never replies: a fetch with no timeout would wait for ever.
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const ntfy = new Ntfy(`http://127.0.0.1:${port}`, undefined, 200);
    await expect(ntfy.poll("t")).rejects.toThrow("no answer in 0.2 s");
    await expect(ntfy.publish("t", "x")).rejects.toThrow("no answer in 0.2 s");
    server.closeAllConnections();
    server.close();
  });
});
