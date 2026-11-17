import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LinkDeps, LinkManager } from "../src/core/link";
import { startPoller } from "../src/core/poller";
import { runtime } from "../src/core/runtime";
import type { Session } from "../src/core/session";

/** A link with no laptop: enough to start, stop and time it. */
function bareLink(): LinkManager {
  return new LinkManager({
    laptops: { current: () => undefined, onChange: () => () => undefined },
  } as unknown as LinkDeps);
}

describe("polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never stacks requests: a tick is skipped while the last one is out", async () => {
    let calls = 0;
    let finish: (v: number) => void = () => undefined;
    const p = startPoller({
      load: () => {
        calls++;
        return new Promise<number>((r) => {
          finish = r;
        });
      },
      ms: 1000,
      timeoutMs: 60_000,
      active: () => true,
      onData: () => undefined,
      onError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    finish(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    p.stop();
  });

  it("asks nothing while the app is in the background, and again at once when it's back", async () => {
    let active = false;
    let calls = 0;
    const p = startPoller({
      load: () => {
        calls++;
        return Promise.resolve(1);
      },
      ms: 1000,
      active: () => active,
      onData: () => undefined,
      onError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
    active = true;
    p.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    p.stop();
  });

  it("waits longer after failures, and a request that never answers counts as one", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const p = startPoller({
      load: () => {
        calls++;
        return new Promise(() => undefined); // a dead link: no answer, ever
      },
      ms: 1000,
      timeoutMs: 2000,
      active: () => true,
      onData: () => undefined,
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toHaveLength(1);
    // The next one waits 2 s (one failure), not 1.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toBe(2);
    p.stop();
  });

  it("keeps the last good answer when a later one fails", async () => {
    const seen: number[] = [];
    let n = 0;
    const p = startPoller({
      load: () => (++n === 1 ? Promise.resolve(42) : Promise.reject(new Error("gone"))),
      ms: 1000,
      active: () => true,
      onData: (d: number) => seen.push(d),
      onError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(3500);
    expect(seen).toEqual([42]);
    p.stop();
  });
});

describe("one session, one link", () => {
  afterEach(() => runtime.close());

  it("two unlocks at once open one session", async () => {
    let made = 0;
    const make = async () => {
      made++;
      await new Promise((r) => setTimeout(r, 10));
      return { link: { start: vi.fn(), stop: vi.fn() } } as unknown as Session;
    };
    const [a, b] = await Promise.all([runtime.open(make), runtime.open(make)]);
    expect(made).toBe(1);
    expect(a).toBe(b);
    // And once open, another unlock is the same session.
    expect(await runtime.open(make)).toBe(a);
    expect(made).toBe(1);
  });

  it("a session put in place of another stops the other's link", () => {
    const one = { link: { start: vi.fn(), stop: vi.fn() } } as unknown as Session;
    const two = { link: { start: vi.fn(), stop: vi.fn() } } as unknown as Session;
    runtime.adopt(one);
    runtime.adopt(two);
    expect(one.link.stop).toHaveBeenCalled();
    expect(two.link.start).toHaveBeenCalled();
  });

  it("starting a link stops any other running in the app", () => {
    const a = bareLink();
    const b = bareLink();
    a.start();
    const stop = vi.spyOn(a, "stop");
    b.start();
    expect(stop).toHaveBeenCalled();
    expect(LinkManager.active).toBe(b);
    b.stop();
    expect(LinkManager.active).toBeNull();
  });
});

describe("a dead connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the laptop not answering the heartbeat closes the connection (and so reconnects)", async () => {
    const link = bareLink();
    const close = vi.fn();
    const l = link as unknown as {
      channel: { isOpen: boolean; close: (r: string) => void };
      client: unknown;
      check(): Promise<void>;
    };
    l.channel = { isOpen: true, close };
    l.client = { status: { query: () => new Promise(() => undefined) } };
    const done = l.check();
    await vi.advanceTimersByTimeAsync(9000);
    await done;
    expect(close).toHaveBeenCalledWith("the laptop stopped answering");
  });

  it("an answer, even a refusal, means it's alive", async () => {
    const link = bareLink();
    const close = vi.fn();
    const l = link as unknown as {
      channel: { isOpen: boolean; close: (r: string) => void };
      client: unknown;
      check(): Promise<void>;
    };
    l.channel = { isOpen: true, close };
    l.client = { status: { query: () => Promise.reject(new Error("may not use status")) } };
    await l.check();
    expect(close).not.toHaveBeenCalled();
  });

  it("retries within seconds in front, half a minute when replaced by another copy", () => {
    const link = bareLink();
    const l = link as unknown as {
      wanted: boolean;
      scheduleRetry(k: string, e: string | null): void;
      state: { retryAt: number | null };
    };
    l.wanted = true;
    for (let i = 0; i < 8; i++) l.scheduleRetry("k", "can't reach the laptop");
    expect((l.state.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(5_750);
    l.scheduleRetry("k", "replaced by a new connection");
    expect((l.state.retryAt ?? 0) - Date.now()).toBeGreaterThan(25_000);
    link.stop();
  });
});
