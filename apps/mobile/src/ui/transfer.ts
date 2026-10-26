/** Moving file contents between the laptop and the phone, in chunks. */
import type { FileEntry, LaptopRouter } from "@ekatva/protocol";
import type { TRPCClient } from "@trpc/client";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

const CHUNK = 4 * 1024 * 1024;

export const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} kB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
      length: Math.min(CHUNK, limit - offset),
    });
    const bytes = fromB64(r.data);
    file.write(r.data, { encoding: "base64", append: offset > 0 });
    offset += bytes.length;
    if (r.eof || !bytes.length) break;
  }
  return file;
}

/** Downloads a laptop file and offers it to the phone's apps (save, open, share). */
export async function downloadToPhone(
  client: TRPCClient<LaptopRouter>,
  e: FileEntry,
): Promise<void> {
  const file = await fetchFile(client, e.path, e.name);
  if (await Sharing.isAvailableAsync())
    await Sharing.shareAsync(file.uri, e.mime ? { mimeType: e.mime } : {});
}
