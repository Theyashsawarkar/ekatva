import type { AgentItem, AgentUpdate } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import { applyUpdate, type Feed, hasOlder, prepend, rows } from "../src/core/agent-feed";
import { markdown, spans } from "../src/core/markdown";

const says = (n: number, text = `s${n}`): AgentItem => ({ kind: "says", n, at: 0, text });
const tool = (n: number, state: "running" | "ok" = "ok"): AgentItem => ({
  kind: "tool",
  n,
  at: 0,
  name: "Bash",
  title: "",
  detail: "",
  state,
  output: "",
  cut: false,
});
const push = (items: AgentItem[], o: Partial<AgentUpdate> = {}): AgentUpdate => ({
  reset: false,
  epoch: "a:1",
  total: 100,
  items,
  queued: [],
  status: null,
  ...o,
});
const ns = (f: Feed) => f.items.map((i) => i.n);

describe("an agent's history on the phone", () => {
  it("starts with the latest, adds and updates, and takes older pages in front", () => {
    let f = applyUpdate(null, push([says(40), tool(41, "running")], { reset: true, total: 42 }));
    f = applyUpdate(f, push([tool(41), says(42)], { total: 43, queued: ["next"] }));
    expect(ns(f)).toEqual([40, 41, 42]);
    expect(f.items[1]).toMatchObject({ state: "ok" });
    expect(f.queued).toEqual(["next"]);
    expect(hasOlder(f)).toBe(true);
    f = prepend(f, { epoch: "a:1", total: 43, items: [says(38), says(39)] });
    expect(ns(f)).toEqual([38, 39, 40, 41, 42]);
    // Not next to what's there, or of another history: left alone.
    expect(prepend(f, { epoch: "a:1", total: 43, items: [says(30)] })).toBe(f);
    expect(prepend(f, { epoch: "a:2", total: 43, items: [says(37)] })).toBe(f);
  });

  it("reconnecting keeps the older pages; a gap, a rewind or another session starts over", () => {
    const f = applyUpdate(null, push([says(1), says(2), says(3)], { reset: true }));
    expect(ns(applyUpdate(f, push([says(2), says(3), says(4)], { reset: true })))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(ns(applyUpdate(f, push([says(40), says(41)], { reset: true })))).toEqual([40, 41]);
    expect(ns(applyUpdate(f, push([says(1)], { reset: true, epoch: "a:2" })))).toEqual([1]);
  });

  it("folds runs of tool calls, newest first", () => {
    const r = rows([says(0), tool(1), tool(2), says(3), tool(4)]);
    expect(r.map((x) => (x.kind === "steps" ? `${x.key}x${x.items.length}` : x.key))).toEqual([
      "s4x1",
      "i3",
      "s2x2",
      "i0",
    ]);
  });
});

describe("markdown", () => {
  it("draws what agents write", () => {
    const md = markdown(
      "# Done\nAll **good**, see `a_b_c.ts`.\n\n- one\n  goes on\n  - two\n1. first\n\n> note\n\n| a | b |\n|---|---|\n| 1 | `x` |\n\n---\n```ts\nconst a = 1;\n\n- not a list\n```\nend",
    );
    expect(md.map((m) => m.kind)).toEqual([
      "h",
      "p",
      "li",
      "li",
      "li",
      "quote",
      "table",
      "hr",
      "code",
      "p",
    ]);
    expect(md[2]).toMatchObject({ depth: 0, spans: [{ text: "one goes on" }] });
    expect(md[3]).toMatchObject({ depth: 1 });
    expect(md[8]).toMatchObject({ lang: "ts", text: "const a = 1;\n\n- not a list" });
    expect(md[6]).toMatchObject({ rows: [[[{ text: "1" }], [{ text: "x", code: true }]]] });
  });

  it("leaves snake_case, paths and stars alone, and an unfinished block is code", () => {
    expect(spans("snake_case_name in src/a_b/c_d.ts, 2 * 3 * 4")).toHaveLength(1);
    expect(spans("go to https://example.org/a. Then [docs](https://x.org)")).toMatchObject([
      { text: "go to " },
      { href: "https://example.org/a" },
      { text: ". Then " },
      { text: "docs", href: "https://x.org" },
    ]);
    expect(markdown("```\nhalf")).toEqual([{ kind: "code", lang: "", text: "half" }]);
    expect(spans("**bold `code`**")).toMatchObject([
      { text: "bold ", bold: true },
      { text: "code", code: true, bold: true },
    ]);
  });
});
