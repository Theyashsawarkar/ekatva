import { expect, test } from "vitest";
import { readableIssues } from "../src/trpc.js";

test("a bad input reads as one sentence", () => {
  expect(readableIssues([{ code: "too_small", minimum: 1, path: ["percent"], message: "x" }])).toBe(
    "percent must be at least 1",
  );
  expect(readableIssues([{ code: "too_big", maximum: 100, path: [], message: "x" }])).toBe(
    "The value must be at most 100",
  );
  expect(readableIssues([{ code: "custom", path: ["level"], message: "nothing to change" }])).toBe(
    "level: nothing to change",
  );
});
