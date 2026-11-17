/**
 * What the laptop sends the phone (see @ekatva/protocol's share): files
 * into Download/ekatva (a new name when one is taken, never outside it),
 * links opened, other text on the clipboard. Each arrival is a notification.
 */
import { type Done, SHARE_MAX, type ShareService, safeName } from "@ekatva/protocol";
import type { Fs } from "./files";

export interface ShareHost {
  /** Where received files go ("/storage/emulated/0/Download/ekatva"). */
  dir(): Promise<string>;
  openUrl(url: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
  notify(title: string, text: string): void;
}

interface Incoming {
  path: string;
  name: string;
  size: number;
  got: number;
  from: string;
  first: boolean;
  at: number;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;
const STALL_MS = 2 * 60_000;

const b64Length = (b64: string) => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};

export class PhoneShareInbox implements ShareService {
  private incoming = new Map<string, Incoming>();

  constructor(
    private readonly fs: Fs,
    private readonly host: ShareHost,
    private readonly now: () => number = Date.now,
  ) {}

  async text(text: string, from: string): Promise<Done<{ opened: boolean }>> {
    const t = text.trim();
    if (URL_RE.test(t)) {
      await this.host.openUrl(t);
      return { value: { opened: true }, summary: `Opened a link from ${from}` };
    }
    await this.host.setClipboard(text);
    this.host.notify(`Text from ${from}`, "On the clipboard");
    return { value: { opened: false }, summary: `Put text from ${from} on the clipboard` };
  }

  async begin(name: string, size: number, from: string): Promise<{ id: string }> {
    if (size > SHARE_MAX) throw new Error("too big to send");
    this.prune();
    const dir = await this.host.dir();
    await this.fs.mkdir(dir).catch(() => undefined);
    const safe = safeName(name);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    let path = "";
    for (let n = 0; n < 1000; n++) {
      const candidate = `${dir}/${n ? `${stem} (${n})${ext}` : safe}`;
      if (!(await this.fs.stat(candidate))) {
        path = candidate;
        break;
      }
    }
    if (!path) throw new Error("no free name in Download/ekatva");
    // An empty file now, so a second transfer with the same name picks another.
    await this.fs.write(path, "");
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    this.incoming.set(id, { path, name: safe, size, got: 0, from, first: true, at: this.now() });
    return { id };
  }

  async put(id: string, data: string): Promise<void> {
    const inc = this.get(id);
    const n = b64Length(data);
    if (inc.got + n > inc.size) {
      await this.cancel(id);
      throw new Error("more data than announced");
    }
    await this.fs.append(inc.path, data);
    inc.got += n;
    inc.at = this.now();
  }

  async finish(id: string): Promise<Done<{ path: string }>> {
    const inc = this.get(id);
    this.incoming.delete(id);
    if (inc.got !== inc.size) {
      await this.fs.remove(inc.path).catch(() => undefined);
      throw new Error(`incomplete: ${inc.got} of ${inc.size} bytes`);
    }
    this.host.notify(`File from ${inc.from}`, `${inc.name} is in Download/ekatva`);
    return { value: { path: inc.path }, summary: `Received ${inc.name} from ${inc.from}` };
  }

  async cancel(id: string): Promise<void> {
    const inc = this.incoming.get(id);
    if (!inc) return;
    this.incoming.delete(id);
    await this.fs.remove(inc.path).catch(() => undefined);
  }

  private get(id: string): Incoming {
    this.prune();
    const inc = this.incoming.get(id);
    if (!inc) throw new Error("no such transfer (it timed out?)");
    return inc;
  }

  /** Transfers gone quiet: dropped, partial files deleted. */
  private prune(): void {
    for (const [id, inc] of this.incoming) if (this.now() - inc.at > STALL_MS) void this.cancel(id);
  }
}
