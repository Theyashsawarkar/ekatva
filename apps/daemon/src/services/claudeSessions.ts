/**
 * Claude Code's running sessions, as it records them itself
 * (~/.claude/sessions/<pid>.json): which tmux pane each is in, its session
 * id, its own name, whether it's busy. A file whose process is gone (or
 * whose pid now belongs to another program) is ignored.
 */
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "%8". */
  pane: string;
  name: string | null;
  /** "derived" (made from the folder), "auto" (from the topic), or one you gave. */
  nameSource: string | null;
  status: string | null;
  startedAt: number;
}

/** When the process started, in clock ticks since boot (field 22), or null. */
function procStart(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command (field 2) may hold spaces and brackets: count from its end.
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether `pid` runs inside the process `ancestor` (a pane's shell), or is it. */
export function within(pid: number, ancestor: number): boolean {
  for (let p = pid, i = 0; p > 1 && i < 12; i++) {
    if (p === ancestor) return true;
    try {
      const s = readFileSync(`/proc/${p}/stat`, "utf8");
      p = Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return false;
    }
  }
  return false;
}

export class ClaudeSessions {
  private paths = new Map<string, string>();

  constructor(
    /** ~/.claude */
    private readonly dir: string,
    private readonly started: (pid: number) => string | null = procStart,
  ) {}

  /** The running sessions, by tmux pane: those that really run in that pane (ids repeat across tmux servers). */
  async byPane(
    inPane: (pane: string, pid: number) => boolean = () => true,
  ): Promise<Map<string, ClaudeSession>> {
    const out = new Map<string, ClaudeSession>();
    const dir = join(this.dir, "sessions");
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const s = JSON.parse(await readFile(join(dir, f), "utf8"));
        const pane = /%\d+$/.exec(String(s.tmux ?? ""))?.[0];
        if (!pane || !/^[\w-]{8,64}$/.test(String(s.sessionId))) continue;
        const start = this.started(Number(s.pid));
        if (start === null || (s.procStart && String(s.procStart) !== start)) continue;
        if (!inPane(pane, Number(s.pid))) continue;
        const prev = out.get(pane);
        if (prev && prev.startedAt > Number(s.startedAt)) continue;
        out.set(pane, {
          pid: Number(s.pid),
          sessionId: String(s.sessionId),
          cwd: String(s.cwd ?? ""),
          pane,
          name: typeof s.name === "string" && s.name ? s.name : null,
          nameSource: typeof s.nameSource === "string" ? s.nameSource : null,
          status: typeof s.status === "string" ? s.status : null,
          startedAt: Number(s.startedAt) || 0,
        });
      } catch {
        // half-written: the next look has it
      }
    }
    return out;
  }

  /** The session's transcript file, or null before it has said anything. */
  async transcript(s: ClaudeSession): Promise<string | null> {
    const known = this.paths.get(s.sessionId);
    if (known) return known;
    const projects = join(this.dir, "projects");
    const file = `${s.sessionId}.jsonl`;
    const guess = join(projects, s.cwd.replace(/[^a-zA-Z0-9]/g, "-"), file);
    const dirs = [
      guess,
      ...(await readdir(projects).catch(() => [])).map((d) => join(projects, d, file)),
    ];
    for (const p of dirs)
      if (
        await stat(p).then(
          (x) => x.isFile(),
          () => false,
        )
      ) {
        this.paths.set(s.sessionId, p);
        return p;
      }
    return null;
  }
}
