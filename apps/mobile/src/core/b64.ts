/**
 * Base64 without the slow paths: encoding in 32 KB slices (one
 * String.fromCharCode per slice, never one per byte), and the decoded length
 * read off the string itself, so nothing is decoded just to be measured.
 */

const SLICE = 0x8000;

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += SLICE)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE) as unknown as number[]);
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function b64Length(b64: string): number {
  const n = b64.length;
  if (!n) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((n * 3) / 4) - pad;
}
