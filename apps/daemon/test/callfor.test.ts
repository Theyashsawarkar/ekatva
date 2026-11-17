import { describe, expect, it } from "vitest";
import { callFor } from "../src/services/calls.js";

describe("how long a call has gone on, on the bar", () => {
  it("says seconds, then minutes, then hours and minutes", () => {
    expect(callFor(45_000)).toBe("45s");
    expect(callFor(12 * 60_000 + 5_000)).toBe("12m");
    expect(callFor(80 * 60_000)).toBe("1h 20m");
    expect(callFor(-5)).toBe("0s");
  });
});
