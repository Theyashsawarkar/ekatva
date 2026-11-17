/**
 * What the phone sends the laptop (see @ekatva/protocol's share): files
 * into ~/Downloads (a new name when one is taken, never outside it), links
 * opened in the default browser, other text on the clipboard. Each arrival
 * is a desktop notification.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { type Done, SHARE_MAX, type ShareService, safeName } from "@ekatva/protocol";

export interface ShareHost {
  openUrl(url: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
  notify(title: string, body: string, file?: string): void;
}

interface Incoming {
  path: string;
  name: string;
  size: number;
  got: number;
  out: WriteStream;
  from: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Only these open on the laptop by themselves. */
const URL_RE = /^https?:\/\/[^\s]+$/i;
/** A transfer that goes quiet this long is dropped (and its partial file deleted). */
const STALL_MS = 2 * 60_000;

export class ShareInbox implements ShareService {
  private incoming = new Map<string, Incoming>();

  constructor(
    private readonly host: ShareHost,
    private readonly dir: string = join(homedir(), "Downloads"),
  ) {}

  async text(text: string, from: string): Promise<Done<{ opened: boolean }>> {
    const t = text.trim();
    if (URL_RE.test(t)) {
      await this.host.openUrl(t);
      this.host.notify(`Link from ${from}`, t);
      return { value: { opened: true }, summary: `Opened a link from ${from}` };
    }
    await this.host.setClipboard(text);
    this.host.notify(`Text from ${from}`, "On the clipboard");
    return { value: { opened: false }, summary: `Put text from ${from} on the clipboard` };
  }

  async begin(name: string, size: number, from: string): Promise<{ id: string }> {
    if (size > SHARE_MAX) throw new Error("too big to send");
    await mkdir(this.dir, { recursive: true });
    const safe = safeName(name);
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    // A new file, never an existing one: "photo.jpg", "photo (1).jpg", …
    let path = "";
    for (let n = 0; n < 1000; n++) {
      const candidate = join(this.dir, n ? `${stem} (${n})${ext}` : safe);
      try {
        await (await open(candidate, "wx", 0o644)).close();
        path = candidate;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    if (!path) throw new Error("no free name in Downloads");
    const id = randomBytes(12).toString("hex");
    const inc: Incoming = {
      path,
      name: safe,
      size,
      got: 0,
      out: createWriteStream(path, { flags: "w" }),
      from,
      timer: setTimeout(() => void this.cancel(id), STALL_MS),
    };
    this.incoming.set(id, inc);
    return { id };
  }

  async put(id: string, data: string): Promise<void> {
    const inc = this.get(id);
    const bytes = Buffer.from(data, "base64");
    if (inc.got + bytes.length > inc.size) {
      await this.cancel(id);
      throw new Error("more data than announced");
    }
    inc.got += bytes.length;
    inc.timer.refresh();
    await new Promise<void>((res, rej) => inc.out.write(bytes, (e) => (e ? rej(e) : res())));
  }

  async finish(id: string): Promise<Done<{ path: string }>> {
    const inc = this.get(id);
    clearTimeout(inc.timer);
    this.incoming.delete(id);
    await new Promise<void>((res) => inc.out.end(() => res()));
    if (inc.got !== inc.size) {
      await rm(inc.path, { force: true });
      throw new Error(`incomplete: ${inc.got} of ${inc.size} bytes`);
    }
    this.host.notify(`File from ${inc.from}`, `${inc.name} is in Downloads`, inc.path);
    return { value: { path: inc.path }, summary: `Received ${inc.name} from ${inc.from}` };
  }

  async cancel(id: string): Promise<void> {
    const inc = this.incoming.get(id);
    if (!inc) return;
    clearTimeout(inc.timer);
    this.incoming.delete(id);
    await new Promise<void>((res) => inc.out.end(() => res()));
    await rm(inc.path, { force: true });
  }

  private get(id: string): Incoming {
    const inc = this.incoming.get(id);
    if (!inc) throw new Error("no such transfer (it timed out?)");
    return inc;
  }
}
