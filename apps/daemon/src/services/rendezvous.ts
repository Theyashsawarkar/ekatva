/**
 * Answering "where are you?" from paired phones that can't reach the
 * laptop directly: start the tunnel, post its URL to the pair's private
 * mailbox (see @ekatva/link's rendezvous). And, unasked, post the new
 * address whenever the tunnel's URL changes, so a phone away finds it at
 * its next look without waiting for an answer.
 *
 * Listening: one long-lived ntfy stream over every phone's mailbox rings a
 * bell when anything is posted, and the mailboxes are then read (as a poll
 * would). It costs one keepalive from the server every 45 s instead of an
 * HTTPS request every 10 s, and a phone's question is answered at once. A
 * stream silent for over a minute (a network that went away under it) is
 * dropped and opened again, and each opening reads the mailboxes, so
 * nothing posted meanwhile is missed. While it can't be opened, the
 * mailboxes are polled every 10 s, as before.
 */
import { ANNOUNCE, fromB64u, type KeyPair, mailbox, Ntfy } from "@ekatva/link";
import type { Tunnel } from "./tunnel.js";

export class Rendezvous {
  private lastId = new Map<string, string>();
  private answered = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly me: KeyPair,
    private readonly devices: () => { key: string; name: string }[],
    private readonly tunnel: Tunnel,
    private readonly lan: () => string[],
    private readonly ntfy: Ntfy = new Ntfy(),
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  private failing = false;
  private running = false;
  private everyMs = 10_000;
  private abort: AbortController | null = null;
  private topics = "";
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1000;
  private safety: ReturnType<typeof setInterval> | null = null;
  private streamFailing = false;

  /** Silence longer than this on the stream means it's dead (ntfy says something every 45 s). */
  static SILENT_MS = 60_000;
  /** A look now and then even while the stream is up, in case it lost something. */
  static SAFETY_MS = 10 * 60_000;

  /**
   * Listens on the mailboxes (`stream` false: polls every `everyMs`, as
   * before the stream).
   */
  start(everyMs = 10_000, stream = true): void {
    if (this.running) return;
    this.running = true;
    this.everyMs = everyMs;
    if (!stream) {
      void this.check();
      this.poll(true);
      return;
    }
    this.safety = setInterval(() => void this.check(), Rendezvous.SAFETY_MS);
    this.safety.unref?.();
    this.listen();
  }

  stop(): void {
    this.running = false;
    this.poll(false);
    if (this.safety) clearInterval(this.safety);
    this.safety = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
  }

  /** The paired phones changed: listen on the new set of mailboxes. */
  refresh(): void {
    if (!this.running || !this.safety) return;
    if (this.topicList().join(",") !== this.topics) this.abort?.abort();
  }

  private poll(on: boolean): void {
    if (on && !this.timer) this.timer = setInterval(() => void this.check(), this.everyMs);
    if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private topicList(): string[] {
    return this.devices().map((d) => mailbox(this.me, fromB64u(d.key)).topic);
  }

  private listen(): void {
    if (!this.running) return;
    const topics = this.topicList();
    this.topics = topics.join(",");
    if (topics.length === 0) {
      // Nothing paired yet: look again later (refresh() comes sooner).
      this.again(60_000);
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    let silent: ReturnType<typeof setTimeout> | null = null;
    const heard = () => {
      if (silent) clearTimeout(silent);
      silent = setTimeout(() => abort.abort(), Rendezvous.SILENT_MS);
      silent.unref?.();
    };
    heard();
    let opened = false;
    this.ntfy
      .stream(
        topics,
        (event) => {
          heard();
          if (event === "open") {
            opened = true;
            this.streamFailing = false;
            this.retryMs = 1000;
            this.poll(false);
            void this.check();
          } else if (event === "message") void this.check();
        },
        abort.signal,
      )
      .catch((e) => {
        if (!abort.signal.aborted && !this.failing && !this.streamFailing)
          this.log(`can't listen at the rendezvous (polling instead): ${(e as Error).message}`);
        if (!abort.signal.aborted) this.streamFailing = true;
      })
      .finally(() => {
        if (silent) clearTimeout(silent);
        if (this.abort === abort) this.abort = null;
        if (!this.running) return;
        // Down: poll meanwhile, and open it again (soon if it had been up).
        this.poll(true);
        if (!opened) void this.check();
        this.again(opened ? 1000 : this.retryMs);
        if (!opened) this.retryMs = Math.min(this.retryMs * 2, 60_000);
      });
  }

  private again(ms: number): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.listen();
    }, ms);
    this.retry.unref?.();
  }

  /** Posts where the laptop is now to every paired phone's mailbox (or one phone's). */
  async announce(url: string | null, only?: string): Promise<void> {
    const lan = this.lan();
    for (const d of this.devices()) {
      if (only && d.key !== only) continue;
      const mb = mailbox(this.me, fromB64u(d.key));
      await this.ntfy
        .publish(mb.topic, mb.seal({ t: "here", at: Date.now(), url, lan, n: ANNOUNCE }))
        .catch((e) => this.log(`couldn't post the new address: ${(e as Error).message}`));
    }
  }

  /** Looks in every paired phone's mailbox once. */
  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const d of this.devices()) {
        const mb = mailbox(this.me, fromB64u(d.key));
        let msgs: { id: string; message: string }[];
        try {
          msgs = await this.ntfy.poll(mb.topic, this.lastId.get(mb.topic) ?? "2m");
        } catch (e) {
          // Offline, or the server is down: next time. Say so once per outage.
          if (!this.failing) this.log(`can't reach the rendezvous: ${(e as Error).message}`);
          this.failing = true;
          continue;
        }
        if (this.failing) this.log("the rendezvous answers again");
        this.failing = false;
        for (const m of msgs) {
          this.lastId.set(mb.topic, m.id);
          const msg = mb.open(m.message);
          if (msg?.t !== "where" || this.answered.has(msg.n)) continue;
          this.answered.add(msg.n);
          this.log(`${d.name} is looking for the laptop from elsewhere`);
          const reach = await this.tunnel.start();
          await this.ntfy
            .publish(
              mb.topic,
              mb.seal({
                t: "here",
                at: Date.now(),
                url: reach.url,
                lan: [...this.lan(), ...reach.lan],
                n: msg.n,
              }),
            )
            .catch(() => undefined);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
