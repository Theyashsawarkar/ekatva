/**
 * Root approvals from the phone.
 *
 * The windows that ask for root (anumati for agents' commands, pramana for
 * polkit) connect to ekatva-root.sock in your runtime directory and hand
 * over their request: newline-delimited JSON.
 *
 *   window → ekatva   {"t":"request","v":1,"id","via","requester","reason","commands":[{cmd,why}]}
 *   ekatva → window   {"t":"answer","approve":true,"allow":[0,2],"password":"…"}
 *   window → ekatva   {"t":"wrong","attempts":1}     the password was wrong
 *   window → ekatva   {"t":"done","status":"completed"}   answered (here or on the phone)
 *
 * ekatva never runs anything as root: the window checks the password and
 * runs what it showed, exactly as if you had typed it at the laptop. The
 * password passes through in memory only, once, and is never logged.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Done, RootRequest } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";

interface Pending extends RootRequest {
  socket: Socket;
}

const MAX_LINE = 256 * 1024;

export class RootBridge {
  private pending = new Map<string, Pending>();
  private listeners = new Set<(r: RootRequest[]) => void>();
  private server: Server | null = null;

  constructor(
    private readonly path: string,
    private readonly log: (m: string) => void = () => undefined,
    /** Tell the phone something needs it, even with the app closed (a push). */
    private readonly onNew: (r: RootRequest) => void = () => undefined,
  ) {}

  async listen(): Promise<void> {
    rmSync(this.path, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    const old = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.path, () => resolve());
      });
    } finally {
      process.umask(old);
    }
    chmodSync(this.path, 0o600);
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) p.socket.destroy();
    this.pending.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    rmSync(this.path, { force: true });
  }

  private accept(socket: Socket): void {
    let buf = "";
    let id: string | null = null;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t === "request" && id === null) id = this.add(msg, socket);
        else if (msg.t === "wrong" && id)
          this.update(id, { state: "wrong", attempts: Number(msg.attempts) || 1 });
        else if (msg.t === "done" && id) {
          this.remove(id);
          socket.end();
        }
      }
    });
    socket.on("close", () => id && this.remove(id));
    socket.on("error", () => id && this.remove(id));
  }

  private add(msg: Record<string, unknown>, socket: Socket): string | null {
    const commands = Array.isArray(msg.commands)
      ? (msg.commands as { cmd?: unknown; why?: unknown }[])
          .filter((c) => typeof c?.cmd === "string")
          .slice(0, 64)
          .map((c) => ({ cmd: String(c.cmd), why: String(c.why ?? "") }))
      : [];
    const via = msg.via === "polkit" ? "polkit" : "anumati";
    if (!commands.length && via === "anumati") {
      socket.destroy();
      return null;
    }
    // Our own id: the window's can't collide with or address another's.
    const id = randomBytes(8).toString("hex");
    const r: Pending = {
      id,
      via,
      requester: String(msg.requester ?? "unknown").slice(0, 200),
      reason: String(msg.reason ?? "").slice(0, 2000),
      commands,
      at: Date.now(),
      state: "waiting",
      attempts: 0,
      socket,
    };
    this.pending.set(id, r);
    this.log(`root request from ${r.requester} (${r.via}): waiting on the laptop and the phone`);
    this.emit();
    this.onNew(this.view(r));
    return id;
  }

  private update(id: string, change: Partial<RootRequest>): void {
    const r = this.pending.get(id);
    if (!r) return;
    Object.assign(r, change);
    this.emit();
  }

  private remove(id: string): void {
    if (this.pending.delete(id)) this.emit();
  }

  private view(p: Pending): RootRequest {
    const { socket: _s, ...r } = p;
    return { ...r, commands: r.commands.map((c) => ({ ...c })) };
  }

  list(): RootRequest[] {
    return [...this.pending.values()].map((p) => this.view(p));
  }

  private emit(): void {
    const l = this.list();
    for (const cb of this.listeners) cb(l);
  }

  async *changes(signal: AbortSignal | undefined): AsyncGenerator<RootRequest[]> {
    const queue: RootRequest[][] = [this.list()];
    let wake: (() => void) | null = null;
    const cb = (l: RootRequest[]) => {
      queue.push(l);
      wake?.();
    };
    this.listeners.add(cb);
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
    } finally {
      this.listeners.delete(cb);
    }
  }

  async respond(
    id: string,
    approve: boolean,
    password: string | null,
    allow: number[] | null,
  ): Promise<Done<null>> {
    const r = this.pending.get(id);
    if (!r)
      throw new TRPCError({ code: "NOT_FOUND", message: "that request was already answered" });
    if (r.state === "checking")
      throw new TRPCError({ code: "CONFLICT", message: "already checking an answer" });
    const n = r.commands.length;
    const chosen = (allow ?? r.commands.map((_, i) => i)).filter((i) => i >= 0 && i < n);
    if (approve && !password)
      throw new TRPCError({ code: "BAD_REQUEST", message: "approving needs your password" });
    if (approve && r.via === "anumati" && !chosen.length)
      throw new TRPCError({ code: "BAD_REQUEST", message: "choose at least one command" });
    const line = JSON.stringify({
      t: "answer",
      approve,
      allow: chosen,
      ...(approve ? { password } : {}),
    });
    r.socket.write(`${line}\n`);
    if (approve) this.update(id, { state: "checking" });
    else this.remove(id);
    const what =
      r.via === "polkit"
        ? "admin rights"
        : `${chosen.length} of ${n} root command${n === 1 ? "" : "s"}`;
    return {
      value: null,
      summary: approve ? `Approved ${what} for ${r.requester}` : `Denied root for ${r.requester}`,
    };
  }
}
