/**
 * What the QR code carries, and the one-time pairing tokens behind it.
 *
 *   ekatva://pair?v=1&k=<laptop key>&t=<token>&n=<name>&lan=<host:port,…>&url=<wss://…>
 *
 * Nothing in it is a lasting secret: the key is public, the token works
 * once and expires, and pairing still needs the emoji confirmed.
 */
import { equal, fromB64u, toB64u } from "./bytes.js";

export const PAIR_TTL_MS = 2 * 60 * 1000;
const TOKEN_BYTES = 16;

export interface PairOffer {
  /** The laptop's static public key. */
  key: Uint8Array;
  /** The one-time token. */
  token: Uint8Array;
  /** The laptop's name, as the phone will show it. */
  name: string;
  /** host:port pairs on the local network. */
  lan: string[];
  /** A tunnel's wss:// URL, when reaching it from anywhere is allowed. */
  url?: string;
}

export function formatOffer(o: PairOffer): string {
  const q = new URLSearchParams({ v: "1", k: toB64u(o.key), t: toB64u(o.token), n: o.name });
  if (o.lan.length) q.set("lan", o.lan.join(","));
  if (o.url) q.set("url", o.url);
  return `ekatva://pair?${q}`;
}

export function parseOffer(text: string): PairOffer {
  const m = /^ekatva:\/\/pair\?(.*)$/s.exec(text.trim());
  if (!m) throw new Error("not an ekatva pairing code");
  const q = new URLSearchParams(m[1]);
  if (q.get("v") !== "1") throw new Error("this pairing code needs a newer app");
  const key = fromB64u(q.get("k") ?? "");
  const token = fromB64u(q.get("t") ?? "");
  if (key.length !== 32 || token.length !== TOKEN_BYTES) throw new Error("damaged pairing code");
  const lan = (q.get("lan") ?? "").split(",").filter((h) => /^[\w.:[\]-]+:\d{1,5}$/.test(h));
  const url = q.get("url") ?? undefined;
  if (url && !/^wss:\/\//.test(url)) throw new Error("a tunnel must be wss://");
  return { key, token, name: (q.get("n") ?? "laptop").slice(0, 64), lan, ...(url ? { url } : {}) };
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Tokens the laptop has shown and not yet seen used. */
export class TokenBook {
  private live: { token: Uint8Array; until: number }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issue(): Uint8Array {
    this.prune();
    const token = randomBytes(TOKEN_BYTES);
    this.live.push({ token, until: this.now() + PAIR_TTL_MS });
    return token;
  }

  /** True once per token, within its lifetime; it's gone afterwards. */
  redeem(token: Uint8Array): boolean {
    this.prune();
    const i = this.live.findIndex((t) => equal(t.token, token));
    if (i < 0) return false;
    this.live.splice(i, 1);
    return true;
  }

  revokeAll(): void {
    this.live = [];
  }

  private prune(): void {
    const now = this.now();
    this.live = this.live.filter((t) => t.until > now);
  }
}
