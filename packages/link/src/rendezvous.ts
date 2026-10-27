/**
 * Finding each other from anywhere: a pair's private mailbox on a public
 * ntfy server (ntfy.sh by default, or your own).
 *
 * The topic and the key come from the two devices' static keys
 * (X25519 → a secret only they can compute), so the server sees a random
 * topic name and ciphertext. The phone asks "where are you?"; the laptop
 * starts its tunnel and answers with the URL. Messages carry their time
 * and are refused when older than 10 minutes, so a replay is useless; and
 * the connection itself still goes through the Noise handshake, so even a
 * correct URL gets nobody anywhere without the keys.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, fromB64u, toB64u, utf8 } from "./bytes.js";
import type { KeyPair } from "./noise.js";

const AD = utf8.encode("ekatva/rv/1");
export const MAX_AGE_MS = 10 * 60 * 1000;

export type RvMessage =
  /** The phone: where are you? */
  | { t: "where"; at: number; n: string }
  /** The laptop: here (a tunnel URL, and its LAN addresses). */
  | { t: "here"; at: number; url: string | null; lan: string[]; n: string };

export interface Mailbox {
  /** The ntfy topic. */
  topic: string;
  seal(msg: RvMessage): string;
  /** The message, or null when it isn't ours, is damaged, or is stale. */
  open(text: string, now?: number): RvMessage | null;
}

export function mailbox(me: KeyPair, other: Uint8Array): Mailbox {
  const shared = x25519.getSharedSecret(me.secretKey, other);
  const derive = (label: string, len: number) =>
    blake2b(concat(utf8.encode(`ekatva/rv/${label}`), shared), { dkLen: len });
  const topic = `ekatva-${toB64u(derive("topic", 18))}`;
  const key = derive("key", 32);
  return {
    topic,
    seal(msg) {
      const nonce = new Uint8Array(12);
      globalThis.crypto.getRandomValues(nonce);
      const box = chacha20poly1305(key, nonce, AD).encrypt(utf8.encode(JSON.stringify(msg)));
      return toB64u(concat(nonce, box));
    },
    open(text, now = Date.now()) {
      try {
        const raw = fromB64u(text.trim());
        if (raw.length < 12 + 16) return null;
        const plain = chacha20poly1305(key, raw.subarray(0, 12), AD).decrypt(raw.subarray(12));
        const msg = JSON.parse(utf8.decode(plain)) as RvMessage;
        if (typeof msg.at !== "number" || Math.abs(now - msg.at) > MAX_AGE_MS) return null;
        if (msg.t !== "where" && msg.t !== "here") return null;
        if (
          msg.t === "here" &&
          msg.url !== null &&
          !/^wss:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(msg.url)
        )
          return null;
        return msg;
      } catch {
        return null;
      }
    },
  };
}

export function nonce(): string {
  const n = new Uint8Array(9);
  globalThis.crypto.getRandomValues(n);
  return toB64u(n);
}

/** A tiny ntfy client over fetch (Node, Electron and React Native have it). */
export class Ntfy {
  constructor(
    readonly server = "https://ntfy.sh",
    private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
    /** A request that hangs would stall finding each other for good: give up and try again. */
    private readonly timeoutMs = 15_000,
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: abort.signal });
    } catch (e) {
      throw abort.signal.aborted ? new Error(`ntfy: no answer in ${this.timeoutMs / 1000} s`) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  async publish(topic: string, message: string): Promise<void> {
    const r = await this.request(`${this.server}/${topic}`, {
      method: "POST",
      body: message,
      headers: { "X-Cache": "no" },
    });
    if (!r.ok) throw new Error(`ntfy: ${r.status}`);
  }

  /** Messages since `since` (an ntfy id, or a duration like "10m"). */
  async poll(topic: string, since = "10m"): Promise<{ id: string; message: string }[]> {
    const r = await this.request(
      `${this.server}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`,
    );
    if (!r.ok) throw new Error(`ntfy: ${r.status}`);
    const out: { id: string; message: string }[] = [];
    for (const line of (await r.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.event === "message" && typeof m.message === "string")
          out.push({ id: m.id, message: m.message });
      } catch {
        // skip
      }
    }
    return out;
  }
}
