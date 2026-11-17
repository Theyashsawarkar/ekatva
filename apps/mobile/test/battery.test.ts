import { generateKeyPair, toB64u } from "@ekatva/link";
import { PIECE } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import { b64Length, fromB64, toB64 } from "../src/core/b64";
import { type LinkDeps, LinkManager } from "../src/core/link";

describe("base64 without the slow paths", () => {
  it("measures without decoding, for every padding", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 32_769]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      const b64 = toB64(bytes);
      expect(b64Length(b64)).toBe(n);
      expect(fromB64(b64)).toEqual(bytes);
    }
  });

  it("encodes past the 32 KB slices the same as one by one", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 13) & 255);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(toB64(bytes)).toBe(btoa(bin));
  });

  it("sends files in 512 KiB pieces, well under what a call accepts", () => {
    expect(PIECE).toBe(512 * 1024);
  });
});

/** A link to a laptop that's never there, with a fake clock and a rendezvous that counts. */
function awayLink(opts: { online?: boolean } = {}) {
  let t = 1_000_000;
  const asks: number[] = [];
  const laptopKey = generateKeyPair().publicKey;
  const laptop = {
    key: toB64u(laptopKey),
    name: "ace",
    lan: ["10.0.0.9:47100"],
    url: null,
    grants: [],
  };
  const link = new LinkManager({
    secrets: { identity: generateKeyPair() },
    laptops: {
      current: () => laptop,
      all: () => [laptop],
      get: () => laptop,
      onChange: () => () => undefined,
      update: async () => undefined,
    },
    open: async () => {
      throw new Error("can't reach the laptop");
    },
    hello: { name: "phone", info: {} },
    now: () => t,
    rendezvousWaitMs: 0,
    ntfy: {
      publish: async () => {
        asks.push(t);
      },
      poll: async () => [],
    },
    ...(opts.online === undefined ? {} : { online: async () => opts.online as boolean }),
  } as unknown as LinkDeps);
  const attempt = () => (link as unknown as { tryConnect(): Promise<void> }).tryConnect();
  return {
    link,
    asks,
    attempt,
    later: (ms: number) => {
      t += ms;
    },
  };
}

describe("the rendezvous, gently", () => {
  it("in front: at most every 2 minutes, however often it retries", async () => {
    const a = awayLink();
    (a.link as unknown as { wanted: boolean }).wanted = true;
    for (let i = 0; i < 10; i++) {
      await a.attempt();
      a.later(5_000);
    }
    expect(a.asks).toHaveLength(1);
    a.later(120_000);
    await a.attempt();
    expect(a.asks).toHaveLength(2);
    a.link.stop();
  });

  it("in the background: every 20 minutes, and at once when the app comes back", async () => {
    const a = awayLink();
    (a.link as unknown as { wanted: boolean }).wanted = true;
    a.link.setForeground(false);
    await a.attempt();
    a.later(5 * 60_000);
    await a.attempt();
    expect(a.asks).toHaveLength(1);
    a.later(16 * 60_000);
    await a.attempt();
    expect(a.asks).toHaveLength(2);
    a.later(1000);
    a.link.setForeground(true);
    await a.attempt();
    expect(a.asks).toHaveLength(3);
    a.link.stop();
  });

  it("never without a network", async () => {
    const a = awayLink({ online: false });
    (a.link as unknown as { wanted: boolean }).wanted = true;
    await a.attempt();
    expect(a.asks).toHaveLength(0);
    a.link.stop();
  });
});
