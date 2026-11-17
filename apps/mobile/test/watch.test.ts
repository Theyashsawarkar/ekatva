import { afterEach, describe, expect, it, vi } from "vitest";
import { blockKeys } from "../src/core/block-keys";
import { sameMedia } from "../src/core/equal";
import { EncryptedStore, MemoryLines, TAIL } from "../src/core/logStore";
import { resetPolls, subscribePoll, WATCH_FALLBACK_MS, type Watch } from "../src/core/poll-store";

const text = (e: unknown) => String(e);

/** A fake push: counts starts and stops, and can send. */
function fakeWatch<T>() {
  const w = { starts: 0, stops: 0, send: (_d: T): void => undefined };
  const watch: Watch<T> = (onData) => {
    w.starts++;
    w.send = onData;
    return () => {
      w.stops++;
    };
  };
  return { w, watch };
}

describe("pushed values (useWatch's store)", () => {
  afterEach(() => {
    resetPolls();
    vi.useRealTimers();
  });

  it("several screens share one push, and a pushed change reaches them all", async () => {
    vi.useFakeTimers();
    const { w, watch } = fakeWatch<{ n: number }>();
    let calls = 0;
    const load = () => {
      calls++;
      return Promise.resolve({ n: 1 });
    };
    const seen: string[] = [];
    const a = subscribePoll(
      "k",
      load,
      WATCH_FALLBACK_MS,
      () => true,
      () => seen.push("a"),
      text,
      { watch },
    );
    const b = subscribePoll(
      "k",
      load,
      WATCH_FALLBACK_MS,
      () => true,
      () => seen.push("b"),
      text,
      { watch },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(w.starts).toBe(1);
    expect(a.get().data).toEqual({ n: 1 });
    w.send({ n: 2 });
    expect(a.get().data).toEqual({ n: 2 });
    expect(b.get().data).toBe(a.get().data);
    // While pushed, the poll is only a slow safety net.
    await vi.advanceTimersByTimeAsync(WATCH_FALLBACK_MS - 1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    a.unsubscribe();
    expect(w.stops).toBe(0);
    b.unsubscribe();
    expect(w.stops).toBe(1);
  });

  it("drops the push when nobody is looking, and starts a new one on a new connection", async () => {
    vi.useFakeTimers();
    let looking = true;
    const first = fakeWatch<number>();
    const s = subscribePoll(
      "k2",
      () => Promise.resolve(1),
      WATCH_FALLBACK_MS,
      () => looking,
      () => undefined,
      text,
      {
        watch: first.watch,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(first.w.starts).toBe(1);
    looking = false;
    s.sync();
    expect(first.w.stops).toBe(1);
    looking = true;
    s.kick();
    expect(first.w.starts).toBe(2);
    // Reconnected: a new client, a new push on it.
    const second = fakeWatch<number>();
    s.setLoad(() => Promise.resolve(1), second.watch);
    expect(first.w.stops).toBe(2);
    expect(second.w.starts).toBe(1);
    s.unsubscribe();
  });
});

describe("media equality", () => {
  const player = (o: Record<string, unknown>) => ({
    id: "nada",
    name: "nāda",
    status: "Playing",
    title: "Alap",
    artist: "",
    album: "",
    artId: "x",
    length: 300_000,
    position: 10_000,
    at: 1_000,
    ...o,
  });
  const media = (p: Record<string, unknown>) => ({
    players: [player(p)],
    volume: null,
    brightness: 80,
  });

  it("a playing song read again later, where it should be by then, is the same", () => {
    expect(sameMedia(media({}), media({ position: 12_000, at: 3_000 }), 5_000)).toBe(true);
  });
  it("a seek (more than a second off), a pause or a new song is a change", () => {
    expect(sameMedia(media({}), media({ position: 40_000, at: 3_000 }), 5_000)).toBe(false);
    expect(sameMedia(media({}), media({ status: "Paused" }), 5_000)).toBe(false);
    expect(sameMedia(media({}), media({ title: "Darbari" }), 5_000)).toBe(false);
    expect(sameMedia(media({}), { ...media({}), brightness: 50 }, 5_000)).toBe(false);
  });
});

describe("the log at unlock", () => {
  it("reads only the tail of the file, not the whole history", async () => {
    const key = new Uint8Array(32).fill(3);
    const lines = new MemoryLines();
    const seed = await EncryptedStore.open(lines, key);
    for (let i = 1; i <= TAIL + 30; i++)
      await seed.append({
        seq: i,
        prev: "",
        hash: "",
        at: "",
        actor: { key: "k", name: "n" },
        action: "a",
        summary: `${i}`,
        input: null,
        ok: true,
      } as never);
    const read = vi.spyOn(lines, "read");
    const store = await EncryptedStore.open(lines, key);
    expect(read).not.toHaveBeenCalled();
    expect((await store.last())?.seq).toBe(TAIL + 30);
    expect(store.size).toBe(TAIL + 30);
    // An older page comes from disk when asked for.
    expect((await store.since(0, 2)).map((e) => e.seq)).toEqual([1, 2]);
    expect(read).toHaveBeenCalled();
  });
});

describe("conversation keys", () => {
  it("keep their keys when old blocks fall off the top", () => {
    const b = (t: string) => ({ kind: "says" as const, text: t });
    const before = blockKeys([b("one"), b("two"), b("three")]);
    const after = blockKeys([b("two"), b("three"), b("four")]);
    expect(after.slice(0, 2)).toEqual(before.slice(1));
    // The same text twice gets two keys.
    const twice = blockKeys([b("ok"), b("ok")]);
    expect(new Set(twice).size).toBe(2);
  });
});
