import { Journal } from "@ekatva/protocol";
import { expect, test } from "vitest";
import { EncryptedStore, MemoryLines, TAIL } from "../src/core/logStore";

const key = new Uint8Array(32).fill(7);
const actor = { key: "local", name: "you" };

test("only the newest entries stay in memory; older ones come from disk, the same", async () => {
  const lines = new MemoryLines();
  const j = new Journal(await EncryptedStore.open(lines, key), "host");
  const n = TAIL + 50;
  for (let i = 0; i < n; i++)
    await j.record({ actor, action: "a", summary: `#${i + 1}`, input: null, ok: true });

  // Reopened, as at unlock: only the tail is decrypted.
  const store = await EncryptedStore.open(lines, key);
  expect(store.size).toBe(n);
  expect((store as unknown as { entries: unknown[] }).entries.length).toBe(TAIL);
  expect((await store.last())?.seq).toBe(n);
  // A page older than the tail, read from disk.
  const old = await store.since(0, 3);
  expect(old.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect((await store.get(5))?.summary).toBe("#5");
  expect((await store.get(n))?.summary).toBe(`#${n}`);
  // And the chain still checks, across the tail's edge.
  expect(await new Journal(store, "host").check()).toBeNull();
});
