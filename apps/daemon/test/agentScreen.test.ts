import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readScreen } from "../src/services/agentScreen.js";

const screen = (name: string) =>
  readFileSync(new URL(`./screens/${name}.txt`, import.meta.url), "utf8");

describe("reading Claude Code's screen", () => {
  it("working: esc to interrupt, with its spinner as the activity", () => {
    const s = readScreen(screen("working"));
    expect(s.state).toBe("working");
    expect(s.question).toBeNull();
    expect(s.activity).toBe("Grooving…");
  });

  it("a permission prompt: the question and its options, wrapped labels joined", () => {
    const s = readScreen(screen("permission"));
    expect(s.state).toBe("waiting");
    expect(s.question?.text).toBe("Do you want to proceed?");
    expect(s.question?.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(s.question?.options[0]?.label).toBe("Yes");
    expect(s.question?.options[2]?.label).toMatch(/^No, and tell Claude/);
    expect(s.question?.hash).toHaveLength(12);
  });

  it("a numbered list in an answer is not a question", () => {
    const s = readScreen(screen("list-answer"));
    expect(s.state).toBe("idle");
    expect(s.question).toBeNull();
  });

  it("a finished session is idle, with its last message", () => {
    const s = readScreen(screen("done"));
    expect(s.state).toBe("idle");
    expect(s.activity.length).toBeGreaterThan(0);
  });

  it("the same question hashes the same; a different one differently", () => {
    const a = readScreen(screen("permission")).question?.hash;
    const b = readScreen(
      screen("permission").replace("pnpm test  ", "rm -rf x  ").replace("proceed?", "continue?"),
    ).question?.hash;
    expect(a).toBe(readScreen(screen("permission")).question?.hash);
    expect(a).not.toBe(b);
  });
});
