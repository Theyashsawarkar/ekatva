import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import { generateKeyPair, Handshake, keyPairFromSecret } from "../src/noise.js";

const require = createRequire(import.meta.url);
// An independent Noise implementation (holepunch's, on libsodium), to prove
// ours speaks the same protocol, byte for byte.
const Reference = require("noise-handshake");
const RefCipher = require("noise-handshake/cipher");

const prologue = utf8.encode("ekatva/1");

function run(a: Handshake, b: Handshake) {
  const p1 = b.read(a.write(utf8.encode("one")));
  const p2 = a.read(b.write(utf8.encode("two")));
  const p3 = b.read(a.write(utf8.encode("three")));
  return [p1, p2, p3].map((p) => utf8.decode(p));
}

describe("Noise XX", () => {
  it("completes between two of ours, with payloads, matching hashes and keys", () => {
    const ps = generateKeyPair();
    const ls = generateKeyPair();
    const phone = new Handshake(true, ps, prologue);
    const laptop = new Handshake(false, ls, prologue);
    expect(run(phone, laptop)).toEqual(["one", "two", "three"]);
    const a = phone.session!;
    const b = laptop.session!;
    expect(a.hash).toEqual(b.hash);
    expect(a.remoteStatic).toEqual(ls.publicKey);
    expect(b.remoteStatic).toEqual(ps.publicKey);
    const msg = utf8.encode("hello laptop");
    expect(b.recv.decrypt(a.send.encrypt(msg))).toEqual(msg);
    expect(a.recv.decrypt(b.send.encrypt(msg))).toEqual(msg);
  });

  it("fails when the prologues differ", () => {
    const phone = new Handshake(true, generateKeyPair(), prologue);
    const laptop = new Handshake(false, generateKeyPair(), utf8.encode("other"));
    laptop.read(phone.write());
    expect(() => phone.read(laptop.write())).toThrow();
  });

  it("rejects a tampered message", () => {
    const phone = new Handshake(true, generateKeyPair(), prologue);
    const laptop = new Handshake(false, generateKeyPair(), prologue);
    laptop.read(phone.write());
    const m2 = laptop.write();
    m2[40] ^= 1;
    expect(() => phone.read(m2)).toThrow();
  });

  it("rejects replayed and reordered transport messages", () => {
    const phone = new Handshake(true, generateKeyPair(), prologue);
    const laptop = new Handshake(false, generateKeyPair(), prologue);
    run(phone, laptop);
    const c1 = phone.session!.send.encrypt(utf8.encode("a"));
    const c2 = phone.session!.send.encrypt(utf8.encode("b"));
    expect(() => laptop.session!.recv.decrypt(c2)).toThrow();
    expect(utf8.decode(laptop.session!.recv.decrypt(c1))).toBe("a");
    expect(() => laptop.session!.recv.decrypt(c1)).toThrow();
  });

  it("refuses a low-order public key", () => {
    const laptop = new Handshake(false, generateKeyPair(), prologue);
    expect(() => {
      laptop.read(new Uint8Array(32));
      laptop.write();
    }).toThrow();
  });

  for (const ourSide of ["initiator", "responder"] as const) {
    it(`interoperates with an independent implementation (we are the ${ourSide})`, () => {
      const ours = generateKeyPair();
      const theirs = new Reference("XX", ourSide !== "initiator");
      theirs.initialise(Buffer.from(prologue));
      const me = new Handshake(
        ourSide === "initiator",
        keyPairFromSecret(ours.secretKey),
        prologue,
      );
      const step = (from: "me" | "them", payload: string) => {
        if (from === "me") {
          const m = me.write(utf8.encode(payload));
          return Buffer.from(theirs.recv(Buffer.from(m))).toString();
        }
        const m = theirs.send(Buffer.from(payload));
        return utf8.decode(me.read(new Uint8Array(m)));
      };
      const order: ("me" | "them")[] =
        ourSide === "initiator" ? ["me", "them", "me"] : ["them", "me", "them"];
      expect(order.map((who, i) => step(who, `m${i}`))).toEqual(["m0", "m1", "m2"]);
      expect(theirs.complete).toBe(true);
      const s = me.session!;
      expect(Buffer.from(s.hash)).toEqual(Buffer.from(theirs.hash));
      expect(Buffer.from(s.remoteStatic)).toEqual(Buffer.from(theirs.s.publicKey));
      // Transport: theirs encrypts with tx, we decrypt with recv, and back.
      const toUs = new RefCipher(theirs.tx).encrypt(Buffer.from("to us"));
      expect(utf8.decode(s.recv.decrypt(new Uint8Array(toUs)))).toBe("to us");
      const toThem = s.send.encrypt(utf8.encode("to them"));
      expect(Buffer.from(new RefCipher(theirs.rx).decrypt(Buffer.from(toThem))).toString()).toBe(
        "to them",
      );
    });
  }
});
