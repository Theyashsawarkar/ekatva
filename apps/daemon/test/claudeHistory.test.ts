import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { draftOf, nameOf } from "../src/services/agents.js";
import { ClaudeHistory, span } from "../src/services/claudeHistory.js";
import { type ClaudeSession, ClaudeSessions } from "../src/services/claudeSessions.js";

// A made-up session, in Claude Code's own format.
const T = "2026-11-24T10:00:00.000Z";
let ids = 0;
const line = (type: string, rest: object, parentUuid: string | null = null) =>
  JSON.stringify({
    type,
    uuid: `u${++ids}`,
    parentUuid,
    timestamp: T,
    isSidechain: false,
    ...rest,
  });
const last = () => `u${ids}`;
const you = (content: unknown, parent: string | null = null, rest: object = {}) =>
  line("user", { message: { role: "user", content }, origin: { kind: "human" }, ...rest }, parent);
const says = (text: string, parent: string | null = null) =>
  line("assistant", { message: { content: [{ type: "text", text }] } }, parent);
const tool = (id: string, name: string, input: object) =>
  line("assistant", { message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, is_error = false) =>
  line("user", {
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
  });
const op = (operation: string, content?: string) =>
  JSON.stringify({
    type: "queue-operation",
    operation,
    timestamp: T,
    ...(content ? { content } : {}),
  });

const of = (...lines: string[]) => {
  const h = new ClaudeHistory("/nowhere");
  for (const l of lines) h.add(l);
  return h;
};
const brief = (h: ClaudeHistory) =>
  h
    .items(0, h.total)
    .map((i) =>
      i.kind === "tool" ? `${i.name} ${i.title}: ${i.state} ${i.output}` : `${i.kind}: ${i.text}`,
    );

describe("a Claude session's history", () => {
  it("is what was said and done, without what the harness adds around it", () => {
    const h = of(
      you("Fix the login<system-reminder>secret notes</system-reminder>"),
      you("a reminder", null, { isMeta: true }),
      line("user", { isSidechain: true, message: { content: "a subagent's prompt" } }),
      says("Looking."),
      tool("t1", "Bash", { command: "pnpm test", description: "Run the tests" }),
      tool("t2", "mcp__narada__mail_read", { query: "login" }),
      // Two at once, answered in the other order.
      result("t2", [{ type: "text", text: "a mail" }]),
      result("t1", "\u001b[31m1 failed\u001b[0m", true),
      line("system", { subtype: "turn_duration", durationMs: 571_892 }),
      line("system", { subtype: "stop_hook_summary", content: "hooks" }),
      line("attachment", { attachment: { type: "environment" } }),
    );
    expect(brief(h)).toEqual([
      "you: Fix the login",
      "says: Looking.",
      "Bash Run the tests: error 1 failed",
      "narada: mail read login: ok a mail",
      "note: Worked for 9m 32s",
    ]);
    expect(h.items(2, 3)[0]).toMatchObject({ detail: "pnpm test" });
  });

  it("tells commands, stops, other sessions and background tasks from your words", () => {
    const h = of(
      you("<command-name>/model</command-name><command-args>opus</command-args>"),
      you("<local-command-stdout>Set model to opus</local-command-stdout>"),
      you([{ type: "text", text: "[Request interrupted by user]" }]),
      you("<task-notification><summary>Build done</summary></task-notification>", null, {
        origin: { kind: "task-notification" },
      }),
      you('<cross-session-message from-name="docs">hello</cross-session-message>', null, {
        origin: { kind: "peer" },
      }),
      line("user", {
        isCompactSummary: true,
        message: { content: "This session is being continued" },
      }),
      line("system", { subtype: "compact_boundary", content: "Conversation compacted" }),
      you([{ type: "image" }, { type: "text", text: "like this" }]),
      line("attachment", {
        attachment: { type: "queued_command", prompt: "and that", origin: { kind: "human" } },
      }),
    );
    expect(brief(h)).toEqual([
      "you: /model opus",
      "note: Set model to opus",
      "note: You stopped it",
      "note: Build done",
      "note: Message from docs: hello",
      "note: Conversation compacted: it remembers a summary of everything above",
      "you: like this",
      "you: and that",
    ]);
    expect(h.items(6, 7)[0]).toMatchObject({ images: 1 });
  });

  it("after a rewind, drops what came after the point it goes on from", () => {
    const h = new ClaudeHistory("/nowhere");
    h.add(you("one"));
    h.add(says("first"));
    const point = last();
    h.add(you("two", point));
    h.add(says("second", last()));
    const epoch = h.epoch;
    h.add(you("two, better", point));
    expect(brief(h)).toEqual(["you: one", "says: first", "you: two, better"]);
    expect(h.epoch).toBe(epoch + 1);
    // Going on as usual is no rewind.
    h.add(says("third", last()));
    h.add(you("three", last()));
    expect(h.epoch).toBe(epoch + 1);
    expect(h.total).toBe(5);
  });

  it("knows what's queued: yours, until it takes it", () => {
    const h = of(
      op("enqueue", "first"),
      op("enqueue", "<task-notification>x</task-notification>"),
      op("enqueue", "second"),
    );
    expect(h.queued()).toEqual(["first", "second"]);
    expect(h.queued(Date.parse(T) + 1)).toEqual([]); // before the session was started again
    h.add(op("remove", "second"));
    expect(h.queued()).toEqual(["first"]);
    h.add(op("dequeue"));
    expect(h.queued()).toEqual([]);
  });

  it("reads only what's added, says what changed, and has a long output whole", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-hist-"));
    const file = join(dir, "s.jsonl");
    const long = `é${"x".repeat(5000)}`;
    const a = you("go ünïcode");
    await fs.writeFile(file, `${a}\n${tool("t9", "Bash", { command: "cat big" }).slice(0, 40)}`);
    const h = new ClaudeHistory(file);
    await h.refresh();
    expect(h.total).toBe(1);
    // The half-written line is finished, and its result comes.
    const t = tool("t9", "Bash", { command: "cat big" });
    await fs.writeFile(file, `${a}\n${t}\n`);
    await h.refresh();
    expect(h.total).toBe(2);
    const v = h.version;
    await fs.appendFile(file, `${result("t9", long)}\n`);
    await h.refresh();
    expect(h.since(v, 0)).toEqual([expect.objectContaining({ n: 1, state: "ok", cut: true })]);
    expect(await h.full(1, h.epoch)).toBe(long);
    await expect(h.full(1, h.epoch + 1)).rejects.toThrow("not in the conversation");
    await fs.rm(dir, { recursive: true });
  });
});

describe("Claude's running sessions", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true });
  });

  it("are found by pane, and not once their process is gone or another's", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-claude-"));
    dirs.push(dir);
    await fs.mkdir(join(dir, "sessions"));
    await fs.mkdir(join(dir, "projects", "-home-asha-shop"), { recursive: true });
    const put = (pid: number, o: object) =>
      fs.writeFile(
        join(dir, "sessions", `${pid}.json`),
        JSON.stringify({
          pid,
          cwd: "/home/asha/shop",
          procStart: "77",
          startedAt: 1,
          status: "busy",
          ...o,
        }),
      );
    await put(10, {
      sessionId: "aaaaaaaa-1",
      tmux: "shop:@1.%3",
      name: "Checkout",
      nameSource: "user",
    });
    await put(11, { sessionId: "bbbbbbbb-1", tmux: "shop:@1.%4", procStart: "78" });
    await put(12, { sessionId: "cccccccc-1", tmux: "shop:@1.%5" });
    await fs.writeFile(join(dir, "projects", "-home-asha-shop", "aaaaaaaa-1.jsonl"), "");
    const c = new ClaudeSessions(dir, (pid) => (pid === 12 ? null : "77"));
    const found = await c.byPane();
    expect([...found.keys()]).toEqual(["%3"]);
    expect(await c.transcript(found.get("%3") as ClaudeSession)).toMatch(/aaaaaaaa-1\.jsonl$/);
  });

  it("are called what Claude calls them", () => {
    const s = { name: "shop-4a", nameSource: "derived" } as ClaudeSession;
    expect(nameOf({ ...s, name: "Checkout", nameSource: "user" }, null, "✳ Topic")).toBe(
      "Checkout",
    );
    expect(nameOf(s, null, "✳ Fixing the login")).toBe("Fixing the login");
    expect(nameOf(s, null, "✳ Claude Code")).toBe("shop-4a");
    expect(nameOf(undefined, null, "zsh")).toBeNull();
    expect(span(3_700_000)).toBe("1h 1m");
  });

  it("words left in the input box are a draft; Claude's dim suggestion isn't", () => {
    const rule = "─".repeat(40);
    const box = (s: string) => `● Done.\n\u001b[38;5;8m${rule}\u001b[0m\n${s}\n${rule}\n  footer`;
    expect(draftOf(box("❯ half a thought"))).toBe("half a thought");
    expect(draftOf(box("❯ \u001b[7mT\u001b[0;2mry: fix lint\u001b[0m"))).toBe("");
    expect(draftOf(box("❯ "))).toBe("");
    expect(draftOf("❯ what you said\n● Done.")).toBe("");
  });
});
