/** Sending to the laptop (its `share`): a file into its Downloads, a link opened, text on its clipboard. */
import type { LaptopRouter } from "@ekatva/protocol";
import type { TRPCClient } from "@trpc/client";
import { File } from "expo-file-system";
import { eachPiece } from "./transfer";

export async function sendFile(
  client: TRPCClient<LaptopRouter>,
  uri: string,
  name: string,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<string> {
  const size = new File(uri).size ?? 0;
  const { id } = await client.share.begin.mutate({ name, size });
  try {
    // Piece by piece from the file: never the whole file in memory.
    await eachPiece(uri, async (data, offset) => {
      if (!data) return;
      await client.share.put.mutate({ id, data });
      onProgress(size ? Math.min(1, offset / size) : 1);
    });
    onProgress(1);
    return (await client.share.finish.mutate({ id })).path;
  } catch (e) {
    await client.share.cancel.mutate({ id }).catch(() => undefined);
    throw e;
  }
}

/** A link opens in the laptop's browser; other text goes on its clipboard. */
export async function sendText(client: TRPCClient<LaptopRouter>, text: string): Promise<string> {
  const r = await client.share.text.mutate({ text });
  return r.opened ? "Opened on the laptop" : "On the laptop's clipboard";
}
