import { describe, expect, it } from "vitest";
import { CallState } from "../src/services/calls.js";

const ev = (
  state: "ringing" | "active" | "ended" | "missed",
  number = "",
  contact: string | null = null,
) => ({ kind: "call", state, number, contact }) as const;

describe("CallState", () => {
  it("follows a call from ringing to answered to ended", () => {
    let t = 1000;
    const c = new CallState(() => t);
    c.onEvent("k1", "Pixel", ev("ringing", "+911234", "Rupali"));
    expect(c.get()).toMatchObject({
      state: "ringing",
      number: "+911234",
      contact: "Rupali",
      since: 1000,
    });
    t = 5000;
    // Android's "answered" event has no number: the one we had stays.
    c.onEvent("k1", "Pixel", ev("active"));
    expect(c.get()).toMatchObject({
      state: "active",
      number: "+911234",
      contact: "Rupali",
      since: 5000,
    });
    t = 9000;
    c.onEvent("k1", "Pixel", ev("active"));
    expect(c.get()?.since).toBe(5000);
    c.onEvent("k1", "Pixel", ev("ended"));
    expect(c.get()).toBeNull();
  });

  it("ignores another phone's end, and forgets a phone that went away", () => {
    const c = new CallState(() => 1);
    c.onEvent("k1", "Pixel", ev("active", "+91"));
    c.onEvent("k2", "Other", ev("ended"));
    expect(c.get()?.device).toBe("k1");
    c.forget("k2");
    expect(c.get()).not.toBeNull();
    c.forget("k1");
    expect(c.get()).toBeNull();
  });

  it("streams the current call, then each change", async () => {
    const c = new CallState(() => 1);
    const ac = new AbortController();
    const seen: (string | null)[] = [];
    const done = (async () => {
      for await (const x of c.changes(ac.signal)) {
        seen.push(x?.state ?? null);
        if (seen.length === 3) ac.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 0));
    c.onEvent("k1", "Pixel", ev("ringing", "+91"));
    c.onEvent("k1", "Pixel", ev("missed"));
    await done;
    expect(seen).toEqual([null, "ringing", null]);
  });
});
