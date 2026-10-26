/** Paired devices and what each may do: devices.json in the state dir, 0600. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Capability, grantable } from "@ekatva/protocol";

export interface DeviceRecord {
  key: string;
  name: string;
  grants: Capability[];
  pairedAt: number;
  lastSeen: number | null;
  info: Record<string, string>;
}

export class Devices {
  private list: DeviceRecord[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as DeviceRecord[];
      this.list = raw.map((d) => ({ ...d, grants: grantable(d.grants) }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  all(): DeviceRecord[] {
    return this.list.map((d) => ({ ...d, grants: [...d.grants], info: { ...d.info } }));
  }

  get(key: string): DeviceRecord | undefined {
    return this.list.find((d) => d.key === key);
  }

  /** A live view of a device's grants: a revocation applies to its next call. */
  grantsOf(key: string): { has(c: Capability): boolean } {
    return { has: (c) => this.get(key)?.grants.includes(c) ?? false };
  }

  async put(d: DeviceRecord): Promise<void> {
    const rec = { ...d, grants: grantable(d.grants) };
    const i = this.list.findIndex((x) => x.key === d.key);
    if (i >= 0) this.list[i] = rec;
    else this.list.push(rec);
    await this.save();
  }

  async remove(key: string): Promise<DeviceRecord | undefined> {
    const d = this.get(key);
    this.list = this.list.filter((x) => x.key !== key);
    await this.save();
    return d;
  }

  async seen(key: string, info?: Record<string, string>): Promise<void> {
    const d = this.get(key);
    if (!d) return;
    d.lastSeen = Date.now();
    if (info) d.info = { ...d.info, ...info };
    await this.save();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.list, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    for (const cb of this.listeners) cb();
  }
}
