/**
 * A Claude Code session's whole conversation, read from its own transcript
 * (a JSONL file it only ever appends to): what you said, what it said, each
 * tool with its result, and what's queued. Read once, then only what was
 * added. Pure parsing (`add`) apart from `refresh` and `full`.
 *
 * The file also holds what nobody reads (hook results, reminders, API
 * records, subagents' talk): left out. After a rewind Claude goes on from an
 * earlier point; what came after that point is dropped, as on its screen.
 *
 * Items are numbered from 0 in order. A number stays with its item while
 * `epoch` is the same; a rewind (or another file) starts a new epoch.
 */
import { open } from "node:fs/promises";
import type { AgentItem } from "@ekatva/protocol";

/** Tool output kept for the list; `full` has all of it. */
const CUT = 1500;
const FULL = 200_000;
const READ = 1 << 20;
const WANTED = /"type":"(?:user|assistant|system|attachment|queue-operation|ai-title|agent-name)"/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Entry {
  item: AgentItem;
  /** Where the tool's result is in the file. */
  at?: { offset: number; length: number };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;
const tag = (s: string, name: string): string | null =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim() ?? null;

/** What a person typed, without what the harness added around it. */
const said = (s: string): string =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

/** "9m 31s". */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** A tool call in a line: what it's for, else what it works on. */
export function toolTitle(
  name: string,
  input: Json,
): { name: string; title: string; detail: string } {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const short = name.replace(/^mcp__(.+?)__(.+)$/, "$1: $2").replace(/_/g, " ");
  const title =
    str(input.description) ||
    (file ? file.split("/").slice(-2).join("/") : "") ||
    str(input.pattern) ||
    str(input.query) ||
    str(input.url) ||
    str(input.command) ||
    str(input.prompt) ||
    str(input.skill) ||
    "";
  let detail = "";
  if (str(input.command)) detail = str(input.command);
  else if (typeof input.old_string === "string")
    detail = [
      ...str(input.old_string)
        .split("\n")
        .map((l) => `- ${l}`),
      ...str(input.new_string)
        .split("\n")
        .map((l) => `+ ${l}`),
    ].join("\n");
  else if (typeof input.content === "string" && file) detail = `${file}\n${input.content}`;
  else if (file) detail = file;
  else if (Object.keys(input).length) detail = JSON.stringify(input, null, 2);
  return {
    name: short,
    title: title.split("\n")[0]?.slice(0, 200) ?? "",
    detail: detail.slice(0, 4000),
  };
}

/** A tool result's text, and how many images it has. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      obj(c).type === "text" ? str(obj(c).text) : obj(c).type === "image" ? "[image]" : "",
    )
    .filter(Boolean)
    .join("\n");
}

export class ClaudeHistory {
  epoch = 1;
  /** Changes with every item added or updated. */
  version = 0;
  aiTitle: string | null = null;
  private entries: Entry[] = [];
  /** Item changes: n → the version it changed at. */
  private changed: number[] = [];
  private tools = new Map<string, number>();
  /** A node's uuid → how many items there were once it was added. */
  private nodes = new Map<string, number>();
  private queue: { text: string; at: number }[] = [];
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private busy: Promise<void> | null = null;
  private inode = 0;

  constructor(readonly file: string) {}

  get total(): number {
    return this.entries.length;
  }

  items(from: number, to: number): AgentItem[] {
    return this.entries.slice(Math.max(0, from), Math.max(0, to)).map((e) => e.item);
  }

  /** Items added or updated after `version`, from item `from` on. */
  since(version: number, from: number): AgentItem[] {
    return this.entries
      .filter((e) => e.item.n >= from && (this.changed[e.item.n] ?? 0) > version)
      .map((e) => e.item);
  }

  /** Your messages waiting for it, oldest first (those sent since `after`, ms). */
  queued(after = 0): string[] {
    return this.queue
      .filter(
        (q) => q.at >= after && !/^\s*<(?:task-notification|cross-session-message)\b/.test(q.text),
      )
      .map((q) => said(q.text))
      .filter(Boolean);
  }

  /** Reads what was added to the file. */
  refresh(): Promise<void> {
    this.busy ??= this.read().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async read(): Promise<void> {
    const f = await open(this.file, "r");
    try {
      const s = await f.stat();
      if (s.size < this.offset || (this.inode && s.ino !== this.inode)) this.reset();
      this.inode = s.ino;
      const buf = Buffer.alloc(READ);
      while (this.offset < s.size) {
        const { bytesRead } = await f.read(buf, 0, READ, this.offset);
        if (!bytesRead) break;
        const start = this.offset - this.rest.length;
        const data = this.rest.length
          ? Buffer.concat([this.rest, buf.subarray(0, bytesRead)])
          : Buffer.from(buf.subarray(0, bytesRead));
        this.offset += bytesRead;
        let from = 0;
        for (let nl = data.indexOf(10, from); nl >= 0; nl = data.indexOf(10, from)) {
          const line = data.toString("utf8", from, nl);
          if (WANTED.test(line)) this.add(line, start + from, nl - from);
          from = nl + 1;
        }
        this.rest = data.subarray(from);
      }
    } finally {
      await f.close();
    }
  }

  private reset(): void {
    this.epoch++;
    this.version++;
    this.entries = [];
    this.changed = [];
    this.tools.clear();
    this.nodes.clear();
    this.queue = [];
    this.offset = 0;
    this.rest = Buffer.alloc(0);
  }

  /** One line of the file. */
  add(line: string, offset = 0, length = 0): void {
    let d: Json;
    try {
      d = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (d.isSidechain === true) return;
    const at = Date.parse(str(d.timestamp)) || 0;
    switch (d.type) {
      case "ai-title":
        this.aiTitle = str(d.aiTitle) || this.aiTitle;
        return;
      case "queue-operation":
        this.queueOp(d, at);
        return;
      case "user":
        this.user(d, at, { offset, length });
        break;
      case "assistant":
        this.assistant(d, at);
        break;
      case "system":
        this.system(d, at);
        break;
      case "attachment":
        this.attachment(d, at);
        break;
      default:
        return;
    }
    if (str(d.uuid)) this.nodes.set(str(d.uuid), this.entries.length);
  }

  private push(item: Record<string, unknown> & { kind: AgentItem["kind"] }): void {
    const n = this.entries.length;
    this.entries.push({ item: { n, ...item } as AgentItem });
    this.changed[n] = ++this.version;
  }

  private note(text: string, at: number, tone: "plain" | "error" = "plain"): void {
    const t = text.replace(ANSI, "").trim();
    if (t) this.push({ kind: "note", at, text: t.slice(0, 2000), tone });
  }

  /** What you typed. After a rewind it hangs from an earlier point: drop what came after that. */
  private you(text: string, at: number, parent: unknown, images: number): void {
    const keep = this.nodes.get(str(parent));
    if (keep !== undefined && this.entries.slice(keep).some((e) => e.item.kind === "you")) {
      this.entries.length = keep;
      this.changed.length = keep;
      for (const [id, n] of this.tools) if (n >= keep) this.tools.delete(id);
      for (const [id, n] of this.nodes) if (n > keep) this.nodes.delete(id);
      this.epoch++;
    }
    if (text || images) this.push({ kind: "you", at, text: text.slice(0, 100_000), images });
  }

  private user(d: Json, at: number, where: { offset: number; length: number }): void {
    const content = obj(d.message).content;
    const list = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(list)) return;
    for (const c of list.map(obj)) {
      if (c.type !== "tool_result") continue;
      const n = this.tools.get(str(c.tool_use_id));
      const e = n === undefined ? undefined : this.entries[n];
      if (n === undefined || e?.item.kind !== "tool") continue;
      const out = resultText(c.content).replace(ANSI, "").trim();
      e.item = {
        ...e.item,
        state: c.is_error === true ? "error" : "ok",
        output: out.slice(0, CUT),
        cut: out.length > CUT,
      };
      if (out.length > CUT) e.at = where;
      this.changed[n] = ++this.version;
    }
    if (d.isMeta === true || d.isCompactSummary === true || d.isVisibleInTranscriptOnly === true)
      return;
    const texts = list.map(obj).filter((c) => c.type === "text");
    const images = list.map(obj).filter((c) => c.type === "image").length;
    if (!texts.length && !images) return;
    this.words(
      texts.map((c) => str(c.text)).join("\n"),
      at,
      d.parentUuid,
      images,
      str(obj(d.origin).kind),
    );
  }

  /** A message that came in: yours, or one the harness or another session wrote. */
  private words(raw: string, at: number, parent: unknown, images: number, origin: string): void {
    if (origin === "task-notification" || /^\s*<task-notification>/.test(raw)) {
      this.note(tag(raw, "summary") ?? "A background task finished", at);
      return;
    }
    if (origin === "peer" || /<cross-session-message\b/.test(raw)) {
      const from = /from-name="([^"]+)"/.exec(raw)?.[1] ?? "another session";
      this.note(
        `Message from ${from}: ${(tag(raw, "cross-session-message") ?? "").slice(0, 600)}`,
        at,
      );
      return;
    }
    const cmd = tag(raw, "command-name");
    if (cmd !== null) {
      this.you(`${cmd} ${tag(raw, "command-args") ?? ""}`.trim(), at, parent, images);
      return;
    }
    const bash = tag(raw, "bash-input");
    if (bash !== null) {
      this.you(`! ${bash}`, at, parent, images);
      return;
    }
    for (const t of [
      "local-command-stdout",
      "local-command-stderr",
      "bash-stdout",
      "bash-stderr",
    ]) {
      const v = tag(raw, t);
      if (v !== null) this.note(v, at);
    }
    if (/^\s*<(?:local-command|bash-std|command-message)/.test(raw)) return;
    if (/^\[Request interrupted by user/.test(raw.trim())) {
      this.note("You stopped it", at);
      return;
    }
    if (origin && origin !== "human") return;
    this.you(said(raw), at, parent, images);
  }

  private assistant(d: Json, at: number): void {
    const content = obj(d.message).content;
    if (!Array.isArray(content)) return;
    for (const c of content.map(obj)) {
      if (c.type === "text") {
        const text = str(c.text).trim();
        if (!text || text === "No response requested.") continue;
        if (d.isApiErrorMessage === true) this.note(text, at, "error");
        else this.push({ kind: "says", at, text: text.slice(0, 100_000) });
      } else if (c.type === "tool_use") {
        this.tools.set(str(c.id), this.entries.length);
        this.push({
          kind: "tool",
          at,
          ...toolTitle(str(c.name), obj(c.input)),
          state: "running",
          output: "",
          cut: false,
        });
      }
    }
  }

  private system(d: Json, at: number): void {
    const text = str(d.content);
    if (d.subtype === "compact_boundary")
      this.note("Conversation compacted: it remembers a summary of everything above", at);
    else if (d.subtype === "turn_duration")
      this.note(`Worked for ${span(Number(d.durationMs) || 0)}`, at);
    else if (d.subtype === "away_summary") this.note(`Recap: ${text}`, at);
    else if (d.subtype === "informational") this.note(text, at);
    else if (d.subtype === "local_command") this.words(text, at, d.parentUuid, 0, "");
  }

  private attachment(d: Json, at: number): void {
    const a = obj(d.attachment);
    if (a.type !== "queued_command") return;
    const p = a.prompt;
    const list = Array.isArray(p) ? p.map(obj) : [];
    const raw =
      typeof p === "string"
        ? p
        : list
            .map((c) => str(c.text))
            .filter(Boolean)
            .join("\n");
    // Absorbed while it worked: never a rewind, so no parent.
    const images = list.filter((c) => c.type === "image").length;
    const kind =
      str(obj(a.origin).kind) || (a.commandMode === "task-notification" ? "task-notification" : "");
    this.words(raw, at, null, images, kind);
  }

  private queueOp(d: Json, at: number): void {
    const text = str(d.content);
    if (d.operation === "enqueue") this.queue.push({ text, at });
    else if (d.operation === "popAll" || d.operation === "clear") this.queue = [];
    else {
      const i = text ? this.queue.findIndex((q) => q.text === text) : 0;
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.version++;
  }

  /** A tool's whole output (the list holds the start of a long one). */
  async full(n: number, epoch: number): Promise<string> {
    const e = this.entries[n];
    if (epoch !== this.epoch || e?.item.kind !== "tool")
      throw new Error("that's not in the conversation any more");
    if (!e.at) return e.item.output;
    const f = await open(this.file, "r");
    try {
      const buf = Buffer.alloc(e.at.length);
      await f.read(buf, 0, e.at.length, e.at.offset);
      const content = obj(obj(JSON.parse(buf.toString("utf8"))).message).content;
      for (const c of (Array.isArray(content) ? content : []).map(obj))
        if (c.type === "tool_result" && this.tools.get(str(c.tool_use_id)) === n)
          return resultText(c.content).replace(ANSI, "").trim().slice(0, FULL);
    } finally {
      await f.close();
    }
    return e.item.output;
  }
}
