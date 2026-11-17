import { expect, test } from "vitest";
import { errorText } from "../src/ui/errors";

test("zod's JSON becomes a sentence", () => {
  const raw = JSON.stringify([
    { code: "too_small", minimum: 1, path: ["percent"], message: "Too small" },
  ]);
  expect(errorText(new Error(raw))).toBe("percent must be at least 1");
});

test("prefixes, stacks and long lines go", () => {
  expect(errorText(new Error("TRPCClientError: not allowed\n    at foo (bar.js:1)"))).toBe(
    "not allowed",
  );
  expect(errorText(new Error("x".repeat(300))).length).toBe(138);
});

test("network failures say so plainly", () => {
  expect(errorText(new TypeError("Network request failed"))).toBe(
    "The laptop didn't answer. Check the connection",
  );
});

test("anything else still says something", () => {
  expect(errorText(undefined)).toBe("Something went wrong");
});
