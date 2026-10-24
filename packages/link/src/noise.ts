/**
 * Noise_XX_25519_ChaChaPoly_BLAKE2b (https://noiseprotocol.org/noise.html),
 * on the audited pure-JS @noble libraries so it runs the same in Node,
 * Electron and React Native (Hermes).
 *
 *   XX:  -> e
 *        <- e, ee, s, es
 *        -> s, se
 *
 * The phone is always the initiator, the laptop the responder. XX sends
 * both static keys encrypted and lets each side check the other's against
 * what it expects (the laptop's key from the QR, the phone's from the
 * paired list), so one pattern serves both pairing and reconnecting.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { concat, equal } from "./bytes.js";

export const PROTOCOL = "Noise_XX_25519_ChaChaPoly_BLAKE2b";
const HASHLEN = 64;
const DHLEN = 32;
/** The largest Noise message (spec §3); larger payloads are split above this layer. */
export const MAX_MESSAGE = 65535;
const TAG = 16;
const MAX_NONCE = 2 ** 53 - 1;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== DHLEN) throw new Error("a secret key is 32 bytes");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function dh(kp: KeyPair, pub: Uint8Array): Uint8Array {
  const out = x25519.getSharedSecret(kp.secretKey, pub);
  // A low-order public key gives all zeros: refuse it rather than mix it in.
  if (out.every((b) => b === 0)) throw new Error("invalid public key");
  return out;
}

const hash = (data: Uint8Array) => blake2b(data, { dkLen: HASHLEN });
const mac = (key: Uint8Array, data: Uint8Array) => hmac(blake2b, key, data);

/** Noise's HKDF (spec §4.3), returning 2 outputs. */
function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = mac(ck, ikm);
  const o1 = mac(temp, Uint8Array.of(1));
  const o2 = mac(temp, concat(o1, Uint8Array.of(2)));
  return [o1, o2];
}

function nonceBytes(n: number): Uint8Array {
  // 4 zero bytes, then the counter as a 64-bit little-endian integer.
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n), true);
  return out;
}

/** A key and its nonce counter: one direction of a session. */
export class CipherState {
  private key: Uint8Array | null = null;
  private n = 0;

  constructor(key?: Uint8Array) {
    if (key) this.key = key;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  init(key: Uint8Array): void {
    this.key = key;
    this.n = 0;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.key) return plaintext;
    if (plaintext.length + TAG > MAX_MESSAGE) throw new Error("message too long");
    if (this.n >= MAX_NONCE) throw new Error("nonce exhausted; reconnect");
    const out = chacha20poly1305(this.key, nonceBytes(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.key) return ciphertext;
    if (ciphertext.length > MAX_MESSAGE) throw new Error("message too long");
    if (this.n >= MAX_NONCE) throw new Error("nonce exhausted; reconnect");
    // Throws on a bad tag; the nonce only advances on success.
    const out = chacha20poly1305(this.key, nonceBytes(this.n), ad).decrypt(ciphertext);
    this.n++;
    return out;
  }
}

class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  cipher = new CipherState();

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL);
    // A name up to HASHLEN bytes is zero-padded, not hashed.
    const h = new Uint8Array(HASHLEN);
    h.set(name);
    this.h = h;
    this.ck = h.slice();
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm);
    this.ck = ck;
    this.cipher.init(k.subarray(0, 32));
  }

  encryptAndHash(p: Uint8Array): Uint8Array {
    const c = this.cipher.encrypt(p, this.h);
    this.mixHash(c);
    return c;
  }

  decryptAndHash(c: Uint8Array): Uint8Array {
    const p = this.cipher.decrypt(c, this.h);
    this.mixHash(c);
    return p;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0));
    return [new CipherState(k1.subarray(0, 32)), new CipherState(k2.subarray(0, 32))];
  }
}

export interface Session {
  /** Encrypts what this side sends. */
  send: CipherState;
  /** Decrypts what this side receives. */
  recv: CipherState;
  /** The handshake hash: identical on both sides, unique to this session. */
  hash: Uint8Array;
  /** The other side's static public key, as proven in the handshake. */
  remoteStatic: Uint8Array;
}

/**
 * One side of an XX handshake. Call write() and read() in turn (the
 * initiator starts with write()); after the third message `session` is set.
 * `ephemeral` exists only for test vectors.
 */
export class Handshake {
  private ss = new SymmetricState();
  private e: KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private step = 0;
  session: Session | null = null;

  constructor(
    readonly initiator: boolean,
    private readonly s: KeyPair,
    prologue: Uint8Array,
    private readonly ephemeral?: KeyPair,
  ) {
    this.ss.mixHash(prologue);
  }

  get complete(): boolean {
    return this.session !== null;
  }

  /** The other side's static key, once its message carrying it was read. */
  get remoteStatic(): Uint8Array | null {
    return this.rs;
  }

  private myTurn(): boolean {
    return this.initiator ? this.step % 2 === 0 : this.step % 2 === 1;
  }

  write(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.complete || !this.myTurn()) throw new Error("not this side's turn to write");
    const ss = this.ss;
    const parts: Uint8Array[] = [];
    if (this.step === 0) {
      this.e = this.ephemeral ?? generateKeyPair();
      parts.push(this.e.publicKey);
      ss.mixHash(this.e.publicKey);
    } else if (this.step === 1) {
      const e = this.ephemeral ?? generateKeyPair();
      this.e = e;
      parts.push(e.publicKey);
      ss.mixHash(e.publicKey);
      ss.mixKey(dh(e, this.need(this.re))); // ee
      parts.push(ss.encryptAndHash(this.s.publicKey)); // s
      ss.mixKey(dh(this.s, this.need(this.re))); // es (responder: s with re)
    } else {
      parts.push(ss.encryptAndHash(this.s.publicKey)); // s
      ss.mixKey(dh(this.s, this.need(this.re))); // se (initiator: s with re)
    }
    parts.push(ss.encryptAndHash(payload));
    this.advance();
    return concat(...parts);
  }

  read(message: Uint8Array): Uint8Array {
    if (this.complete || this.myTurn()) throw new Error("not this side's turn to read");
    if (message.length > MAX_MESSAGE) throw new Error("message too long");
    const ss = this.ss;
    let off = 0;
    const take = (n: number) => {
      if (message.length < off + n) throw new Error("handshake message too short");
      const out = message.subarray(off, off + n);
      off += n;
      return out;
    };
    if (this.step === 0) {
      this.re = take(DHLEN).slice();
      ss.mixHash(this.re);
    } else if (this.step === 1) {
      this.re = take(DHLEN).slice();
      ss.mixHash(this.re);
      ss.mixKey(dh(this.need(this.e), this.re)); // ee
      this.rs = ss.decryptAndHash(take(DHLEN + TAG)).slice(); // s
      ss.mixKey(dh(this.need(this.e), this.rs)); // es (initiator: e with rs)
    } else {
      this.rs = ss.decryptAndHash(take(DHLEN + TAG)).slice(); // s
      ss.mixKey(dh(this.need(this.e), this.rs)); // se (responder: e with rs)
    }
    const payload = ss.decryptAndHash(message.subarray(off));
    this.advance();
    return payload;
  }

  private advance(): void {
    this.step++;
    if (this.step < 3) return;
    const [c1, c2] = this.ss.split();
    this.session = {
      send: this.initiator ? c1 : c2,
      recv: this.initiator ? c2 : c1,
      hash: this.ss.h,
      remoteStatic: this.need(this.rs),
    };
    this.e = null;
  }

  private need<T>(v: T | null): T {
    if (v === null) throw new Error("handshake out of order");
    return v;
  }
}

export { equal as keysEqual };
