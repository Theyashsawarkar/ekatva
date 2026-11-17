import type { AgentBlock } from "@ekatva/protocol";

/** A short hash of a string (FNV-1a), for keys. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * Keys by content, not position: the transcript is a sliding window over the
 * last lines, so when old blocks fall off the top the others keep their keys
 * (an index key shifted them all, and every block re-rendered). Repeats of the
 * same block get a running count.
 */
export function blockKeys(blocks: readonly AgentBlock[]): string[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const base = `${b.kind}:${hash(b.kind === "tool" ? `${b.title}\u0000${b.output}` : b.text)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}
