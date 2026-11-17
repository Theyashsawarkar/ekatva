import type { Entry } from "@ekatva/protocol";
import { entryAt, pageAfter } from "@ekatva/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { same } from "../src/core/equal";
import { resetPolls, subscribePoll } from "../src/core/poll-store";
import { cached } from "../src/core/unchanged";

const text = (e: unknown) => String(e);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("shared polls", () => {
  afterEach(() => {
    resetPolls();
    vi.useRealTimers();
  });

  it("two screens asking the same thing make one request and both get the answer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const load = () => {
      calls++;
      return Promise.resolve({ n: 1 });
    };
    const seen: number[] = [];
    const a = subscribePoll(
      "agents",
      load,
      1000,
      () => true,
      () => seen.push(1),
      text,
    );
    const b = subscribePoll(
      "agents",
      load,
      1000,
      () => true,
      () => seen.push(2),
      text,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(a.get().data).toEqual({ n: 1 });
    expect(b.get().data).toBe(a.get().data);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    a.unsubscribe();
    b.unsubscribe();
  });

  it("an answer equal to the last one keeps the old object and tells no one", async () => {
    vi.useFakeTimers();
    const changes: number[] = [];
    const s = subscribePoll(
      "status",
      () => Promise.resolve({ battery: { percent: 80 }, list: [1, 2] }),
      500,
      () => true,
      () => changes.push(1),
      text,
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = s.get().data;
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.get().data).toBe(first);
    expect(changes.length).toBe(1);
    s.unsubscribe();
  });

  it("asks nothing while no subscriber is active (out of focus, in the background)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let active = false;
    const s = subscribePoll(
      "media",
      () => {
        calls++;
        return Promise.resolve(1);
      },
      500,
      () => active,
      () => undefined,
      text,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(0);
    active = true;
    s.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    s.unsubscribe();
  });

  it("a screen's own poll is forgotten when it goes; a shared one keeps its answer", async () => {
    const a = subscribePoll(
      "~1",
      () => Promise.resolve(5),
      1000,
      () => true,
      () => undefined,
      text,
    );
    await tick();
    a.unsubscribe();
    const again = subscribePoll(
      "~1",
      () => null,
      1000,
      () => true,
      () => undefined,
      text,
    );
    expect(again.get().data).toBeNull();
    again.unsubscribe();
    const b = subscribePoll(
      "roots",
      () => Promise.resolve(7),
      1000,
      () => true,
      () => undefined,
      text,
    );
    await tick();
    b.unsubscribe();
    const back = subscribePoll(
      "roots",
      () => null,
      1000,
      () => true,
      () => undefined,
      text,
    );
    expect(back.get().data).toBe(7);
    back.unsubscribe();
  });
});

describe("plain-data equality", () => {
  it("compares deeply", () => {
    expect(same({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(same({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(same([1], { 0: 1 })).toBe(false);
  });
});

describe("unchanged answers", () => {
  it("keeps the last full answer when the laptop says it's unchanged", () => {
    const c = cached<{ text: string }>();
    expect(c.unless).toBeUndefined();
    const full = c.take({ text: "hi", hash: "h1" });
    expect(c.unless).toBe("h1");
    expect(c.take({ unchanged: true, hash: "h1" })).toBe(full);
    // A laptop from before `unless`: every answer full, no hash.
    const old = cached<{ text: string }>();
    expect(old.take({ text: "x" })).toEqual({ text: "x" });
    expect(old.unless).toBeUndefined();
  });
});

describe("log paging", () => {
  const log = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1 }) as Entry);
  it("pages by seq without scanning", () => {
    expect(pageAfter(log, 0, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(pageAfter(log, 1998, 10).map((e) => e.seq)).toEqual([1999, 2000]);
    expect(pageAfter(log, 2000, 10)).toEqual([]);
    expect(entryAt(log, 1234)?.seq).toBe(1234);
    expect(entryAt(log, 0)).toBeNull();
    expect(entryAt(log, 2001)).toBeNull();
  });
});
