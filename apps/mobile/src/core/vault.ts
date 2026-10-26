/**
 * The app's secrets (this phone's identity key, the log's key), sealed
 * twice: encrypted with a key derived from your app password (scrypt),
 * and stored in Android's keystore behind your fingerprint. Opening the
 * app needs both.
 */
import {
  fromB64u,
  generateKeyPair,
  type KeyPair,
  keyPairFromSecret,
  toB64u,
  utf8,
} from "@ekatva/link";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { KV } from "./kv.js";

const KEY = "ekatva.vault";
/** scrypt cost: ~0.5 s on a phone, far more for anyone guessing. */
const N = 2 ** 15;

export interface Secrets {
  identity: KeyPair;
  /** Encrypts the action log at rest. */
  logKey: Uint8Array;
}

interface Sealed {
  v: 1;
  n: number;
  salt: string;
  nonce: string;
  box: string;
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Async, so the UI keeps drawing while it works. */
const derive = (password: string, salt: Uint8Array, n: number) =>
  scryptAsync(utf8.encode(password.normalize("NFKC")), salt, {
    N: n,
    r: 8,
    p: 1,
    dkLen: 32,
    asyncTick: 20,
  });

/** How strong a password looks (0–4), and what would make it stronger. */
const COMMON =
  /password|passw0rd|qwerty|asdf|letmein|welcome|admin|iloveyou|monkey|dragon|football|abc123|123456|ekatva|android|samsung|pixel/i;

export function strength(password: string): { score: number; hint: string | null } {
  if (password.length < 10) return { score: 0, hint: "at least 10 characters" };
  if (COMMON.test(password)) return { score: 1, hint: "avoid common words like that" };
  if (new Set(password).size < 6) return { score: 1, hint: "more different characters" };
  // A word with digits tacked on is the first thing guessed.
  if (/^[a-z]+\d{0,4}[!.?]?$/i.test(password) && password.length < 16)
    return { score: 2, hint: "mix it up, or use a few words" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const bits = password.length * Math.log2([0, 26, 52, 62, 94][classes] ?? 26);
  if (bits < 60) return { score: 2, hint: "longer, or mix in numbers and symbols" };
  if (bits < 80) return { score: 3, hint: null };
  return { score: 4, hint: null };
}

export class Vault {
  static async exists(kv: KV): Promise<boolean> {
    return (await kv.get(KEY)) !== null;
  }

  static async create(kv: KV, password: string, n = N): Promise<Secrets> {
    if (strength(password).score < 3) throw new Error("choose a stronger password");
    const secrets: Secrets = { identity: generateKeyPair(), logKey: random(32) };
    await Vault.seal(kv, password, secrets, n);
    return secrets;
  }

  static async open(kv: KV, password: string): Promise<Secrets> {
    const raw = await kv.get(KEY);
    if (!raw) throw new Error("not set up");
    const s = JSON.parse(raw) as Sealed;
    const key = await derive(password, fromB64u(s.salt), s.n);
    let plain: Uint8Array;
    try {
      plain = chacha20poly1305(key, fromB64u(s.nonce), utf8.encode(KEY)).decrypt(fromB64u(s.box));
    } catch {
      throw new Error("wrong password");
    }
    const j = JSON.parse(utf8.decode(plain));
    return { identity: keyPairFromSecret(fromB64u(j.identity)), logKey: fromB64u(j.logKey) };
  }

  static async changePassword(kv: KV, old: string, next: string, n = N): Promise<void> {
    const secrets = await Vault.open(kv, old);
    if (strength(next).score < 3) throw new Error("choose a stronger password");
    await Vault.seal(kv, next, secrets, n);
  }

  private static async seal(kv: KV, password: string, secrets: Secrets, n: number): Promise<void> {
    const salt = random(16);
    const nonce = random(12);
    const key = await derive(password, salt, n);
    const plain = utf8.encode(
      JSON.stringify({
        identity: toB64u(secrets.identity.secretKey),
        logKey: toB64u(secrets.logKey),
      }),
    );
    const box = chacha20poly1305(key, nonce, utf8.encode(KEY)).encrypt(plain);
    const sealed: Sealed = { v: 1, n, salt: toB64u(salt), nonce: toB64u(nonce), box: toB64u(box) };
    await kv.set(KEY, JSON.stringify(sealed));
  }

  /** Erases everything (forgot the password): pair again afterwards. */
  static async wipe(kv: KV): Promise<void> {
    await kv.remove(KEY);
  }
}
