/** The laptops this phone is paired with, and what each may do here. */
import { CAPABILITIES, type Capability } from "@ekatva/protocol";
import type { KV } from "./kv";

export interface LaptopRecord {
  key: string;
  name: string;
  lan: string[];
  url: string | null;
  pairedAt: number;
  lastSeen: number | null;
  /** What this laptop may do on the phone (phone.* capabilities). */
  grants: Capability[];
}

const KEY = "ekatva.laptops";

/** What a newly paired laptop may do on the phone: everything on this side. */
export const PHONE_DEFAULT: Capability[] = (Object.keys(CAPABILITIES) as Capability[]).filter(
  (c) => CAPABILITIES[c].side === "phone",
);

export class Laptops {
  private list: LaptopRecord[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly kv: KV) {}

  async load(): Promise<void> {
    const raw = await this.kv.get(KEY);
    this.list = raw ? JSON.parse(raw) : [];
  }

  all(): LaptopRecord[] {
    return this.list.map((l) => ({ ...l, lan: [...l.lan], grants: [...l.grants] }));
  }

  get(key: string): LaptopRecord | undefined {
    return this.list.find((l) => l.key === key);
  }

  /** The one to connect to: the most recently seen. */
  current(): LaptopRecord | undefined {
    return [...this.list].sort(
      (a, b) => (b.lastSeen ?? b.pairedAt) - (a.lastSeen ?? a.pairedAt),
    )[0];
  }

  grantsOf(key: string): { has(c: Capability): boolean } {
    return { has: (c) => this.get(key)?.grants.includes(c) ?? false };
  }

  async put(l: LaptopRecord): Promise<void> {
    const i = this.list.findIndex((x) => x.key === l.key);
    if (i >= 0) this.list[i] = l;
    else this.list.push(l);
    await this.save();
  }

  async update(key: string, change: Partial<LaptopRecord>): Promise<void> {
    const l = this.get(key);
    if (l) await this.put({ ...l, ...change });
  }

  async remove(key: string): Promise<void> {
    this.list = this.list.filter((l) => l.key !== key);
    await this.save();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async save(): Promise<void> {
    await this.kv.set(KEY, JSON.stringify(this.list));
    for (const cb of this.listeners) cb();
  }
}
