/**
 * The app's secrets (this phone's identity key, the log's key), in a
 * `SecretBox`: on the phone, sealed by a keystore key that never leaves its
 * secure hardware and opens only right after your fingerprint or your
 * phone's screen lock (Android's own prompt). No app password.
 *
 * Vaults made before were also sealed with an app password (v1, kept by
 * expo-secure-store): opened once with it, they move into the box.
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
import type { KV } from "./kv";

/** Where the secrets live: sealed text, opened after Android checks it's you. */
export interface SecretBox {
  exists(): Promise<boolean>;
  /** Seals `text`; rejects when you cancel. */
  seal(text: string): Promise<void>;
  /** The sealed text (null: nothing sealed); rejects when you cancel or the key is gone. */
  open(): Promise<string | null>;
  wipe(): Promise<void>;
}

/** The box without a native module (tests, Expo Go): kept in the KV, unprotected. */
export function kvBox(kv: KV): SecretBox {
  const K = "ekatva.box";
  return {
    exists: async () => (await kv.get(K)) !== null,
    seal: (text) => kv.set(K, text),
    open: () => kv.get(K),
    wipe: () => kv.remove(K),
  };
}

/** The legacy vault (v1, password-sealed, in expo-secure-store behind the fingerprint). */
const OLD = "ekatva.vault";
/** "The legacy vault exists": readable without the fingerprint. */
const OLD_MARK = "ekatva.vault.set";
/** The legacy vault as the fingerprint released it, until its password opens it. */
let released: string | null = null;

export interface Secrets {
  identity: KeyPair;
  /** Encrypts the action log at rest. */
  logKey: Uint8Array;
}

interface V1 {
  v: 1;
  n: number;
  salt: string;
  nonce: string;
  box: string;
}
interface V3 {
  v: 3;
  identity: string;
  logKey: string;
}

/** A vault from before: its old app password, once, moves it into the box. */
export class NeedsPassword extends Error {
  constructor() {
    super("enter your old app password once, to move to the fingerprint and screen lock");
  }
}

/** Android dropped the box's key (the screen lock was removed): only starting over helps. */
export class KeyGone extends Error {
  constructor() {
    super(
      "Android dropped ekatva's key (was the phone's screen lock removed or reset?), so its keys can't be opened. Start over and pair again.",
    );
  }
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const encode = (s: Secrets): string =>
  JSON.stringify({
    v: 3,
    identity: toB64u(s.identity.secretKey),
    logKey: toB64u(s.logKey),
  } satisfies V3);

const decode = (text: string): Secrets => {
  const j = JSON.parse(text) as V3;
  return { identity: keyPairFromSecret(fromB64u(j.identity)), logKey: fromB64u(j.logKey) };
};

const gone = (e: unknown) =>
  (e as { code?: string })?.code === "E_KEY_GONE" ||
  /E_KEY_GONE|key is gone|dropped the key/i.test(String((e as Error)?.message ?? e));

/**
 * Laptop passwords for Unlock (the laptop's lock screen), by laptop key, in
 * the same box as the keys: each read is one fingerprint (or screen lock),
 * each change one to read and one to seal. Never kept in memory: the app
 * opens the box for one unlock and forgets the text.
 */
export const LaptopPasswords = {
  async get(box: SecretBox, laptop: string): Promise<string | null> {
    const text = await box.open();
    if (!text) return null;
    const pw = (JSON.parse(text) as { unlock?: Record<string, string> }).unlock?.[laptop];
    return typeof pw === "string" && pw ? pw : null;
  },

  /** Keeps it (null: forgets it). */
  async set(box: SecretBox, laptop: string, password: string | null): Promise<void> {
    const text = await box.open();
    if (!text) throw new Error("not set up");
    const j = JSON.parse(text) as V3 & { unlock?: Record<string, string> };
    const unlock = { ...(j.unlock ?? {}) };
    if (password) unlock[laptop] = password;
    else delete unlock[laptop];
    await box.seal(JSON.stringify({ ...j, unlock }));
  },
};

export const Vault = {
  /** Set up? Never asks for the fingerprint. */
  async exists(box: SecretBox, kv: KV): Promise<boolean> {
    if (await box.exists()) return true;
    // A vault from before: its mark, or (older still, no mark) the paired laptops it left;
    // reading the vault itself would ask for the fingerprint just to choose a screen.
    return (await kv.get(OLD_MARK)) !== null || (await kv.get("ekatva.laptops")) !== null;
  },

  /** First run: new keys, into the box (Android asks for the fingerprint or screen lock). */
  async create(box: SecretBox): Promise<Secrets> {
    const secrets: Secrets = { identity: generateKeyPair(), logKey: random(32) };
    await box.seal(encode(secrets));
    return secrets;
  },

  /** One fingerprint (or the screen lock). A legacy vault throws NeedsPassword. */
  async open(box: SecretBox, kv: KV): Promise<Secrets> {
    if (await box.exists()) {
      let text: string | null;
      try {
        text = await box.open();
      } catch (e) {
        if (gone(e)) throw new KeyGone();
        throw e;
      }
      if (text) return decode(text);
    }
    released ??= await kv.get(OLD);
    if (!released) throw new Error("not set up");
    throw new NeedsPassword();
  },

  /** A legacy vault: its old password opens it, then it moves into the box. */
  async openWithPassword(box: SecretBox, kv: KV, password: string): Promise<Secrets> {
    released ??= await kv.get(OLD);
    if (!released) throw new Error("not set up");
    const s = JSON.parse(released) as V1;
    const key = await scryptAsync(utf8.encode(password.normalize("NFKC")), fromB64u(s.salt), {
      N: s.n,
      r: 8,
      p: 1,
      dkLen: 32,
    });
    let plain: Uint8Array;
    try {
      plain = chacha20poly1305(key, fromB64u(s.nonce), utf8.encode(OLD)).decrypt(fromB64u(s.box));
    } catch {
      throw new Error("wrong password");
    }
    const j = JSON.parse(utf8.decode(plain)) as { identity: string; logKey: string };
    const secrets: Secrets = {
      identity: keyPairFromSecret(fromB64u(j.identity)),
      logKey: fromB64u(j.logKey),
    };
    await box.seal(encode(secrets));
    await kv.remove(OLD);
    await kv.remove(OLD_MARK);
    released = null;
    return secrets;
  },

  /** Erases everything (starting over): pair again afterwards. */
  async wipe(box: SecretBox, kv: KV): Promise<void> {
    await box.wipe();
    await kv.remove(OLD);
    await kv.remove(OLD_MARK);
    released = null;
  },
};

/** For tests: a legacy vault, as the app made them with a password. */
export async function sealV1(
  kv: KV,
  password: string,
  secrets: Secrets,
  n = 2 ** 10,
): Promise<void> {
  const salt = random(16);
  const nonce = random(12);
  const key = await scryptAsync(utf8.encode(password.normalize("NFKC")), salt, {
    N: n,
    r: 8,
    p: 1,
    dkLen: 32,
  });
  const plain = utf8.encode(
    JSON.stringify({
      identity: toB64u(secrets.identity.secretKey),
      logKey: toB64u(secrets.logKey),
    }),
  );
  const box = chacha20poly1305(key, nonce, utf8.encode(OLD)).encrypt(plain);
  const v1: V1 = { v: 1, n, salt: toB64u(salt), nonce: toB64u(nonce), box: toB64u(box) };
  await kv.set(OLD, JSON.stringify(v1));
  await kv.set(OLD_MARK, "1");
}
