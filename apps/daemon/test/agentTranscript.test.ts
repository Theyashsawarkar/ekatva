import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backgroundAgents, readScreen } from "../src/services/agentScreen.js";
import { transcript } from "../src/services/agentTranscript.js";

const screen = (name: string) =>
  readFileSync(new URL(`./screens/${name}`, import.meta.url), "utf8");

describe("an agent's screen, read as a conversation", () => {
  const t = transcript(screen("transcript.txt"));

  it("splits what you said, what it said, its tools and its notes", () => {
    expect(t.blocks.map((b) => b.kind)).toEqual([
      "you",
      "says",
      "tool",
      "tool",
      "tool",
      "says",
      "note",
    ]);
    expect(t.blocks[0]).toEqual({ kind: "you", text: "add the export button and check the tests" });
    expect(t.blocks[2]).toEqual({
      kind: "tool",
      title: "Bash(pnpm test --filter api)",
      output: "Tests  6 passed (6)\nDuration 2.1s",
    });
    expect(t.blocks[3]).toMatchObject({ kind: "tool", title: "Ran 2 shell commands" });
    expect(t.blocks.at(-1)).toEqual({ kind: "note", text: "Worked for 3m 12s" });
  });

  it("undoes the terminal's line wraps, and keeps lists and paragraphs", () => {
    expect(t.blocks[1]).toEqual({
      kind: "says",
      text: "I'll add an export button to the asset page and wire it to the existing download endpoint, then run the test suites.",
    });
    const plan = t.blocks[5];
    expect(plan?.kind === "says" && plan.text.split("\n")).toEqual([
      "The plan has three parts, all small enough to review in one go, and none of them change the schema:",
      "",
      "- The server streams the file; it never stores a copy of what the person downloads anywhere.",
      "  - Large files go in chunks of 4 MiB, each checked against the size limit before it is sent back to the browser.",
      "- Tests use a fake storage server.",
      "",
      "I'll build it once the review is in.",
    ]);
  });

  it("leaves out the input box and the footer, and says what it's doing now", () => {
    expect(JSON.stringify(t.blocks)).not.toMatch(/auto mode|──|security-reviewer {2}Reading/);
    expect(t.status).toBe("Waiting for 1 background agent to finish");
  });
});

describe("working, as today's Claude Code shows it", () => {
  const box = ["─".repeat(60), "❯ ", "─".repeat(60), "", "  ⏵⏵ auto mode on (shift+tab to cycle)"];

  it("is working while its spinner runs (no 'esc to interrupt' any more)", () => {
    const s = readScreen(
      [
        "● Reading the files",
        "",
        "✶ Transfiguring… (16s · ↓ 1.1k tokens · thought for 5s)",
        "",
        ...box,
      ].join("\n"),
    );
    expect(s.state).toBe("working");
    expect(s.activity).toBe("Transfiguring…");
  });

  it("is working while it waits for its background agents", () => {
    const cap = screen("transcript.txt");
    expect(readScreen(cap).state).toBe("working");
    expect(backgroundAgents(cap)).toEqual([
      { name: "security-reviewer", activity: "Reading the export handler" },
    ]);
  });

  it("is idle once its turn ended", () => {
    const s = readScreen(["● Done: all green.", "", "✻ Worked for 2m 3s", "", ...box].join("\n"));
    expect(s.state).toBe("idle");
  });
});

describe("what broke on a real screen", () => {
  const W = 100;
  const pad = (l: string) => l.padEnd(W);
  const screen = (lines: string[]) =>
    [...lines, "─".repeat(W), "❯ ", "─".repeat(W), "", "  ⏵⏵ auto mode on"].map(pad).join("\n");

  it("keeps the agent's text out of your bubble, and quotes as quotes", () => {
    const t = transcript(
      screen([
        "> clude^?^?^?",
        "  So the fault is on Claude Code's side.",
        "",
        "❯ /chrome",
        "  ⎿  Now using browser 1",
        "",
        "❯ check",
        "",
        "  Called claude-in-chrome",
        "",
        "● Searching now.",
        "",
        "  Called claude-in-chrome 8 times",
        "",
        "  Calling claude-in-chrome, narada 2 times…",
      ]),
    );
    expect(t.blocks.map((b) => b.kind)).toEqual([
      "says",
      "you",
      "note",
      "you",
      "tool",
      "says",
      "tool",
      "tool",
    ]);
    const first = t.blocks[0];
    expect(first?.kind === "says" && first.text).not.toMatch(/\^\?/);
    expect(t.blocks[1]).toEqual({ kind: "you", text: "/chrome" });
    expect(t.blocks[2]).toEqual({ kind: "note", text: "Now using browser 1" });
    expect(t.blocks[3]).toEqual({ kind: "you", text: "check" });
    expect(t.blocks.at(-1)).toMatchObject({
      kind: "tool",
      title: "Calling claude-in-chrome, narada 2 times…",
    });
  });

  it("ends what you typed at a blank line", () => {
    const t = transcript(screen(["❯ fix it", "", "  The agent's reply without a marker."]));
    expect(t.blocks).toEqual([
      { kind: "you", text: "fix it" },
      { kind: "says", text: "The agent's reply without a marker." },
    ]);
  });
});
