import { describe, expect, it } from "vitest";
import { fromB64u, toB64u, utf8 } from "../src/bytes.js";
import { accept, type Candidate, CLOSE, connect, LinkError, PORT_LAPTOP } from "../src/channel.js";
import { generateKeyPair } from "../src/noise.js";
import { formatOffer, parseOffer, TokenBook } from "../src/pairing.js";
import { pipe } from "./memory.js";

const laptopKey = generateKeyPair();
const phoneKey = generateKeyPair();
const opts = { keepaliveMs: 0 };

describe("channel", () => {
  it("pairs with a token, both sides seeing the same emoji, then talks", async () => {
    const book = new TokenBook();
    const token = book.issue();
    const offer = parseOffer(
      formatOffer({ key: laptopKey.publicKey, token, name: "ace", lan: ["192.168.1.7:47100"] }),
    );
    const [pt, lt] = pipe();
    let seen: Candidate | undefined;
    let phoneEmoji: string[] = [];
    const laptopSide = accept(lt, {
      ...opts,
      me: laptopKey,
      hello: { v: 1, name: "ace" },
      authorize: (c) => {
        seen = c;
        const t = c.hello.token ? fromB64u(c.hello.token) : null;
        return t && book.redeem(t)
          ? { ok: true, welcome: { grants: ["media"] } }
          : { ok: false, reason: "no" };
      },
    });
    const phone = await connect(pt, {
      ...opts,
      me: phoneKey,
      expect: offer.key,
      hello: { v: 1, name: "Pixel", token: toB64u(offer.token) },
      onSas: (e) => {
        phoneEmoji = e;
      },
    });
    const laptop = await laptopSide;
    expect(phone.welcome).toEqual({ grants: ["media"] });
    expect(seen?.sas).toEqual(phoneEmoji);
    expect(phoneEmoji).toHaveLength(4);
    expect(laptop.remoteStatic).toEqual(phoneKey.publicKey);
    expect(laptop.peer.name).toBe("Pixel");
    expect(phone.channel.peer.name).toBe("ace");

    const got = new Promise<string>((res) =>
      laptop.onPort(PORT_LAPTOP, (d) => res(utf8.decode(d))),
    );
    phone.channel.sendText(PORT_LAPTOP, "hello");
    expect(await got).toBe("hello");

    // A big message crosses in fragments.
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const back = new Promise<Uint8Array>((res) => phone.channel.onPort(PORT_LAPTOP, res));
    laptop.send(PORT_LAPTOP, big);
    expect(await back).toEqual(big);

    // The token is spent.
    expect(book.redeem(token)).toBe(false);
    phone.channel.close();
  });

  it("refuses a laptop whose key isn't the expected one", async () => {
    const [pt, lt] = pipe();
    const impostor = accept(lt, {
      ...opts,
      me: generateKeyPair(),
      hello: { v: 1, name: "evil" },
      authorize: () => ({ ok: true }),
    }).catch((e) => e);
    await expect(
      connect(pt, {
        ...opts,
        me: phoneKey,
        expect: laptopKey.publicKey,
        hello: { v: 1, name: "p" },
      }),
    ).rejects.toMatchObject({ code: CLOSE.wrongKey });
    expect(await impostor).toBeInstanceOf(LinkError);
  });

  it("tells a phone the laptop refused it", async () => {
    const [pt, lt] = pipe();
    const l = accept(lt, {
      ...opts,
      me: laptopKey,
      hello: { v: 1, name: "ace" },
      authorize: () => ({ ok: false, reason: "not paired" }),
    }).catch((e) => e);
    await expect(
      connect(pt, {
        ...opts,
        me: phoneKey,
        expect: laptopKey.publicKey,
        hello: { v: 1, name: "p" },
      }),
    ).rejects.toMatchObject({ code: CLOSE.denied, message: "not paired" });
    expect(await l).toBeInstanceOf(LinkError);
  });

  it("closes on a tampered frame", async () => {
    const [pt, lt] = pipe();
    const lp = accept(lt, {
      ...opts,
      me: laptopKey,
      hello: { v: 1, name: "a" },
      authorize: () => ({ ok: true }),
    });
    const { channel } = await connect(pt, {
      ...opts,
      me: phoneKey,
      expect: laptopKey.publicKey,
      hello: { v: 1, name: "p" },
    });
    const laptop = await lp;
    const reason = new Promise<string>((res) => laptop.onClose(res));
    const phoneClosed = new Promise<string>((res) => channel.onClose(res));
    // Garbage, as if injected on the network.
    pt.send(new Uint8Array(40));
    expect(await reason).toBe("bad frame");
    await phoneClosed;
    expect(channel.isOpen).toBe(false);
  });
});

describe("pairing offer and tokens", () => {
  it("round-trips the QR payload and rejects damaged ones", () => {
    const o = {
      key: laptopKey.publicKey,
      token: new Uint8Array(16).fill(7),
      name: "ace",
      lan: ["10.0.0.2:47100"],
      url: "wss://x.trycloudflare.com",
    };
    expect(parseOffer(formatOffer(o))).toEqual(o);
    expect(() => parseOffer("https://evil")).toThrow();
    expect(() => parseOffer(formatOffer(o).replace("wss%3A", "ws%3A"))).toThrow();
    expect(() => parseOffer(formatOffer({ ...o, token: new Uint8Array(3) }))).toThrow();
  });

  it("tokens work once and expire", () => {
    let now = 0;
    const book = new TokenBook(() => now);
    const a = book.issue();
    const b = book.issue();
    expect(book.redeem(a)).toBe(true);
    expect(book.redeem(a)).toBe(false);
    now = 3 * 60 * 1000;
    expect(book.redeem(b)).toBe(false);
  });

  it("base64url round-trips every length", () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(fromB64u(toB64u(b))).toEqual(b);
    }
  });
});
