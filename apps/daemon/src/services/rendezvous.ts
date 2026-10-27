/**
 * Answering "where are you?" from paired phones that can't reach the
 * laptop directly: start the tunnel, post its URL to the pair's private
 * mailbox (see @ekatva/link's rendezvous).
 */
import { fromB64u, type KeyPair, mailbox, Ntfy } from "@ekatva/link";
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

  start(everyMs = 10_000): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
