/**
 * Finding each other on the same network, with or without the internet
 * (a home Wi-Fi, the phone's own hotspot): the laptop broadcasts a small
 * UDP datagram on each local network every few seconds, one per paired
 * phone, sealed with a key only that pair can compute (X25519 of the two
 * static keys → BLAKE2b). The phone listens on BEACON_PORT; a datagram it
 * can open tells it "your laptop is at <sender's address>:<port>".
 *
 * Nothing in a beacon is readable or linkable by anyone else: a fresh
 * random nonce each time, no name, no key, no fixed bytes. A copied
 * beacon is only good for two minutes and only says where to knock; the
 * connection itself still has to pass the Noise handshake against the
 * laptop's key, so a beacon replayed from elsewhere leads nowhere.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, utf8 } from "./bytes.js";
import type { KeyPair } from "./noise.js";

/** Where phones listen for beacons (the laptop's link listens on 47100). */
export const BEACON_PORT = 47101;
export const BEACON_MAX_AGE_MS = 2 * 60_000;
const AD = utf8.encode("ekatva/beacon/1");
const NONCE = 12;
const PLAIN = 10; // time (8, float64 ms) + port (2)
/** The size of every beacon on the wire. */
export const BEACON_SIZE = NONCE + PLAIN + 16;

export interface Beacon {
  /** When it was sent (ms since the epoch). */
  at: number;
  /** The laptop's link port. */
  port: number;
}

/** The pair's beacon key: the same on both sides, nobody else can compute it. */
export function beaconKey(me: KeyPair, other: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(me.secretKey, other);
  return blake2b(concat(utf8.encode("ekatva/beacon/key"), shared), { dkLen: 32 });
}

export function sealBeacon(key: Uint8Array, b: Beacon): Uint8Array {
  const plain = new Uint8Array(PLAIN);
  const view = new DataView(plain.buffer);
  view.setFloat64(0, b.at);
  view.setUint16(8, b.port);
  const nonce = new Uint8Array(NONCE);
  globalThis.crypto.getRandomValues(nonce);
  return concat(nonce, chacha20poly1305(key, nonce, AD).encrypt(plain));
}

/** The beacon, or null when it isn't for this pair, is damaged, or is stale. */
export function openBeacon(key: Uint8Array, data: Uint8Array, now = Date.now()): Beacon | null {
  if (data.length !== BEACON_SIZE) return null;
  try {
    const plain = chacha20poly1305(key, data.subarray(0, NONCE), AD).decrypt(data.subarray(NONCE));
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const at = view.getFloat64(0);
    const port = view.getUint16(8);
    if (!Number.isFinite(at) || Math.abs(now - at) > BEACON_MAX_AGE_MS || port < 1024) return null;
    return { at, port };
  } catch {
    return null;
  }
}
