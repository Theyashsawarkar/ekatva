/**
 * Everything the app runs once unlocked: the secrets, the paired laptops,
 * the phone's action log and its copies of the laptops', the phone's API,
 * and the link. Built from a `Platform`, so tests can give it fakes.
 */
import { type Ntfy, toB64u } from "@ekatva/link";
import { Journal, type PhoneServices } from "@ekatva/protocol";
import { type Fs, PhoneFiles } from "./files";
import type { KV } from "./kv";
import { Laptops } from "./laptops";
import { type Beacons, LinkManager, type Opener } from "./link";
import { EncryptedStore, type Lines } from "./logStore";
import { type DeviceApi, phoneServices } from "./services";
import { PhoneShareInbox, type ShareHost } from "./share";
import { kvBox, type SecretBox, type Secrets, Vault } from "./vault";

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
  /** The rendezvous server (finding the laptop from elsewhere). */
  ntfy?: Ntfy;
  /** Where the keys live (the keystore box); default: the KV, unprotected (tests). */
  box?: SecretBox;
  /** Where files and links from the laptop go. */
  shareHost?: ShareHost;
  /** Deletes the app's files (logs, undo store) when starting over. */
  wipeFiles?: () => Promise<void>;
  /** Datagrams on the beacon port (the laptop saying where it is on this network). */
  beacons?: Beacons;
  /** Is there any network at all? */
  online?: () => Promise<boolean>;
}

/** Without a share host (tests): files go to the app's own folder, nothing opens. */
const noShare: ShareHost = {
  dir: async () => "/app/received",
  openUrl: async () => undefined,
  setClipboard: async () => undefined,
  notify: () => undefined,
};

const boxOf = (p: Platform): SecretBox => p.box ?? kvBox(p.kv);

export class Session {
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
    return Vault.exists(boxOf(p), p.kv);
  }

  /**
   * Starting over, for a forgotten password: the sealed secrets, the paired laptops, the
   * logs and the undo store, all gone. Nothing can open them without the password anyway.
   */
  static async reset(p: Platform): Promise<void> {
    await Vault.wipe(boxOf(p), p.kv);
    await p.kv.remove("ekatva.laptops");
    await p.wipeFiles?.();
  }

  /** First run: new keys, behind the fingerprint. */
  static async create(p: Platform): Promise<Session> {
    return Session.start(p, await Vault.create(boxOf(p)));
  }

  /** The fingerprint opens it (a vault from before throws NeedsPassword, once). */
  static async unlock(p: Platform): Promise<Session> {
    return Session.start(p, await Vault.open(boxOf(p), p.kv));
  }

  /** A vault from before: its old app password, once; afterwards the fingerprint alone. */
  static async unlockWithPassword(p: Platform, password: string): Promise<Session> {
    return Session.start(p, await Vault.openWithPassword(boxOf(p), p.kv, password));
  }

  private static async start(p: Platform, secrets: Secrets): Promise<Session> {
    const laptops = new Laptops(p.kv);
    await laptops.load();
    const own = await EncryptedStore.open(p.lines("log-self"), secrets.logKey);
    const journal = new Journal(own, toB64u(secrets.identity.publicKey));
    if (own.unreadable)
      p.onAlert?.(`${own.unreadable} line(s) of this phone's action log couldn't be read`);
    // The chain is checked in the Log tab, from a remembered checkpoint, not here at every
    // unlock (that decrypted and hashed the whole history before the first screen).
    // Copies of laptops' logs this phone kept before: the laptop keeps its own; read it there.
    for (const l of laptops.all()) void p.lines(`log-${l.key}`).remove?.();
    const files = new PhoneFiles(p.fs, await p.roots(), p.undoDir);
    const share = new PhoneShareInbox(p.fs, p.shareHost ?? noShare);
    const services = phoneServices(p.device, files, share);
    let session: Session | null = null;
    const link = new LinkManager({
      secrets,
      laptops,
      journal,
      services,
      open: p.open,
      hello: { name: p.device.name, info: p.info },
      ...(p.onAlert ? { onAlert: p.onAlert } : {}),
      ...(p.ntfy ? { ntfy: p.ntfy } : {}),
      ...(p.beacons ? { beacons: p.beacons } : {}),
      ...(p.online ? { online: p.online } : {}),
    });
    session = new Session(p, secrets, laptops, journal, files, services, link);
    return session;
  }
}
