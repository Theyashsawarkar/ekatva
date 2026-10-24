/**
 * The four emoji both screens show while pairing: a short authentication
 * string derived from the handshake hash, which is identical on both sides
 * only when nobody sits in between.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, utf8 } from "./bytes.js";

/** 64 emoji that are easy to tell apart and to name out loud. */
export const EMOJI = [
  "🦊",
  "🐼",
  "🐙",
  "🦉",
  "🐢",
  "🦋",
  "🐝",
  "🐳",
  "🦁",
  "🐧",
  "🦒",
  "🐘",
  "🦀",
  "🐌",
  "🦔",
  "🐸",
  "🌙",
  "⭐",
  "🔥",
  "🌈",
  "❄️",
  "⚡",
  "🌊",
  "🌵",
  "🍋",
  "🍉",
  "🍇",
  "🍒",
  "🥕",
  "🌽",
  "🍄",
  "🥥",
  "🚲",
  "🚀",
  "⛵",
  "🚂",
  "🎈",
  "🎸",
  "🥁",
  "🎺",
  "🔑",
  "🔔",
  "💡",
  "📎",
  "✂️",
  "🧲",
  "🧭",
  "⌛",
  "🍕",
  "🍩",
  "🧁",
  "🍪",
  "☕",
  "🍯",
  "🧀",
  "🥨",
  "⚽",
  "🏀",
  "🎯",
  "🎲",
  "🧩",
  "🪁",
  "🛼",
  "🏓",
] as const;

/** Four emoji (24 bits) for this session's handshake hash. */
export function sas(handshakeHash: Uint8Array): string[] {
  const d = blake2b(concat(utf8.encode("ekatva/sas/1"), handshakeHash), { dkLen: 32 });
  const n = ((d[0] as number) << 16) | ((d[1] as number) << 8) | (d[2] as number);
  return [18, 12, 6, 0].map((shift) => EMOJI[(n >> shift) & 63] as string);
}
