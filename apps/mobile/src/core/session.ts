/**
 * Everything the app runs once unlocked: the secrets, the paired laptops,
 * the phone's action log and its copies of the laptops', the phone's API,
 * and the link. Built from a `Platform`, so tests can give it fakes.
 */
import { toB64u } from "@ekatva/link";
import { Journal, type JournalStore, Mirror, type PhoneServices } from "@ekatva/protocol";
import { type Fs, PhoneFiles } from "./files";
import type { KV } from "./kv";
import { Laptops } from "./laptops";
import { LinkManager, type Opener } from "./link";
import { EncryptedStore, type Lines } from "./logStore";
import { type DeviceApi, phoneServices } from "./services";
import { type Secrets, Vault } from "./vault";

export interface Platform {
  kv: KV;
  /** A named file of lines in the app's private storage. */
  lines(name: string): Lines;
  fs: Fs;
  /** The folders shared with the laptop; the first is "~". */
  roots(): Promise<string[]>;
  undoDir: string;
  device: DeviceApi;
  open: Opener;
  info: Record<string, string>;
  onAlert?: (message: string) => void;
}

export class Session {
  private mirrors = new Map<string, Mirror>();

  private constructor(
    readonly platform: Platform,
    readonly secrets: Secrets,
    readonly laptops: Laptops,
    readonly journal: Journal,
    readonly files: PhoneFiles,
    readonly services: PhoneServices,
    readonly link: LinkManager,
  ) {}

  /** This phone's key, as the laptop knows it. */
  get id(): string {
    return toB64u(this.secrets.identity.publicKey);
  }

  static isSetUp(p: Platform): Promise<boolean> {
    return Vault.exists(p.kv);
  }

  static async create(p: Platform, password: string, n?: number): Promise<Session> {
    return Session.start(p, await Vault.create(p.kv, password, n));
  }

  static async unlock(p: Platform, password: string): Promise<Session> {
    return Session.start(p, await Vault.open(p.kv, password));
  }

  private static async start(p: Platform, secrets: Secrets): Promise<Session> {
    const laptops = new Laptops(p.kv);
    await laptops.load();
    const own = await EncryptedStore.open(p.lines("log-self"), secrets.logKey);
    const journal = new Journal(own, toB64u(secrets.identity.publicKey));
    if (own.unreadable)
      p.onAlert?.(`${own.unreadable} line(s) of this phone's action log couldn't be read`);
    const problem = await journal.check();
    if (problem)
      p.onAlert?.(`This phone's action log fails its check at #${problem.seq}: ${problem.why}`);
    const files = new PhoneFiles(p.fs, await p.roots(), p.undoDir);
    const services = phoneServices(p.device, files);
    let session: Session | null = null;
    const link = new LinkManager({
      secrets,
      laptops,
      journal,
      mirror: (key) => (session as Session).mirrorOf(key),
      services,
      open: p.open,
      hello: { name: p.device.name, info: p.info },
      ...(p.onAlert ? { onAlert: p.onAlert } : {}),
    });
    session = new Session(p, secrets, laptops, journal, files, services, link);
    return session;
  }

  async mirrorOf(laptopKey: string): Promise<Mirror> {
    let m = this.mirrors.get(laptopKey);
    if (!m) {
      const store: JournalStore = await EncryptedStore.open(
        this.platform.lines(`log-${laptopKey}`),
        this.secrets.logKey,
      );
      m = new Mirror(store, laptopKey);
      this.mirrors.set(laptopKey, m);
    }
    return m;
  }
}
