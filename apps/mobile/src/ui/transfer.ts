/** Moving file contents between the laptop and the phone, in chunks. */
import { type FileEntry, type LaptopRouter, PIECE } from "@ekatva/protocol";
import type { TRPCClient } from "@trpc/client";
import { Directory, File, Paths } from "expo-file-system";
import { b64Length, toB64 } from "../core/b64";

export const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} kB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

/**
 * Reads a phone file piece by piece (never whole into memory) and hands each
 * piece over as base64, with where it starts; an empty file gives one empty piece.
 */
export async function eachPiece(
  uri: string,
  onPiece: (b64: string, offset: number, size: number) => Promise<void>,
  piece = PIECE,
): Promise<number> {
  const file = new File(uri);
  const size = file.size ?? 0;
  const h = file.open();
  try {
    let offset = 0;
    do {
      const bytes = await h.readBytes(piece);
      await onPiece(toB64(bytes), offset, size);
      offset += bytes.length;
      if (!bytes.length) break;
    } while (offset < size);
    return offset;
  } finally {
    h.close();
  }
}

/** Fetches a laptop file into the phone's cache; returns it. */
export async function fetchFile(
  client: TRPCClient<LaptopRouter>,
  path: string,
  name: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<File> {
  const dir = new Directory(Paths.cache, "from-laptop");
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  for (let offset = 0; offset < limit; ) {
    const r = await client.files.read.query({
      path,
      offset,
      length: Math.min(PIECE, limit - offset),
    });
    const got = b64Length(r.data);
    file.write(r.data, { encoding: "base64", append: offset > 0 });
    offset += got;
    if (r.eof || !got) break;
  }
  return file;
}

/** Downloads a laptop file and offers it to the phone's apps (save, open, share). */
export async function downloadToPhone(
  client: TRPCClient<LaptopRouter>,
  e: FileEntry,
): Promise<void> {
  const file = await fetchFile(client, e.path, e.name);
  // Loaded when first needed, not at launch.
  const Sharing = await import("expo-sharing");
  if (await Sharing.isAvailableAsync())
    await Sharing.shareAsync(file.uri, e.mime ? { mimeType: e.mime } : {});
}
