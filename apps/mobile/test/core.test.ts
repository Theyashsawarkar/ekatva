import * as fs from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, loadConfig } from "@ekatva/daemon";
import { generateKeyPair, webSocketTransport } from "@ekatva/link";
import type { LocalRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PhoneFiles } from "../src/core/files";
import { MemoryKV } from "../src/core/kv";
import { LinkManager } from "../src/core/link";
import { MemoryLines } from "../src/core/logStore";
import type { DeviceApi } from "../src/core/services";
import { type Platform, Session } from "../src/core/session";
import { KeyGone, NeedsPassword, type SecretBox, sealV1, Vault } from "../src/core/vault";
import { MemFs } from "./memfs";

const PASSWORD = "correct horse battery 9!";

function platform(): Platform & {
  rang: () => number;
  kvMap: MemoryKV;
  files: Map<string, MemoryLines>;
} {
  const kv = new MemoryKV();
  const files = new Map<string, MemoryLines>();
  const memfs = new MemFs();
  let rang = 0;
  let ringing = false;
  let awake = false;
  let clip = "";
  const device: DeviceApi = {
    name: "Pixel 8",
    battery: async () => ({ percent: 82, charging: false }),
    signal: async () => ({ bars: 3, network: "5G" }),
    locked: async () => false,
    ring: async () => {
      rang++;
      ringing = true;
    },
    stopRinging: async () => {
      ringing = false;
    },
    ringing: () => ringing,
    keepAwake: async (on) => {
      awake = on;
    },
    awake: () => awake,
    clipboardGet: async () => clip,
    clipboardSet: async (t) => {
      clip = t;
    },
    lock: null,
    calls: null,
    sms: null,
    notifications: null,
  };
  void memfs.mkdir("/storage/emulated/0/Download");
  return {
    kv,
    kvMap: kv,
    files,
    lines: (name) => {
      const l = files.get(name) ?? new MemoryLines();
      files.set(name, l);
      return l;
    },
    fs: memfs,
    roots: async () => ["/storage/emulated/0"],
    undoDir: "/data/ekatva/undo",
    device,
    open: (url, timeoutMs) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("timed out"));
        }, timeoutMs);
        ws.once("open", () => {
          clearTimeout(timer);
          resolve(webSocketTransport(ws as never));
        });
        ws.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      }),
    info: { app: "test" },
    rang: () => rang,
  };
}

describe("the vault", () => {
  /** A box like the phone's: counts each time Android would ask for the fingerprint. */
  const testBox = () => {
    let text: string | null = null;
    let gone = false;
    const asked = { n: 0 };
    const box: SecretBox = {
      exists: async () => text !== null,
      seal: async (t) => {
        asked.n++;
        text = t;
      },
      open: async () => {
        asked.n++;
        if (gone) throw Object.assign(new Error("the key is gone"), { code: "E_KEY_GONE" });
        return text;
      },
      wipe: async () => {
        text = null;
      },
    };
    return { box, asked, drop: () => (gone = true) };
  };

  it("opens with one fingerprint, and none just to start the app", async () => {
    const { box, asked } = testBox();
    const kv = new MemoryKV();
    const made = await Vault.create(box);
    asked.n = 0;
    expect(await Vault.exists(box, kv)).toBe(true);
    expect(asked.n).toBe(0);
    const opened = await Vault.open(box, kv);
    expect(asked.n).toBe(1);
    expect(opened.identity.publicKey).toEqual(made.identity.publicKey);
    expect(opened.logKey).toEqual(made.logKey);
  });

  it("moves a vault from before (app password) into the box, once", async () => {
    const { box } = testBox();
    const kv = new MemoryKV();
    const old = await Vault.create(testBox().box);
    await sealV1(kv, PASSWORD, old);
    expect(await Vault.exists(box, kv)).toBe(true);
    await expect(Vault.open(box, kv)).rejects.toBeInstanceOf(NeedsPassword);
    await expect(Vault.openWithPassword(box, kv, "wrong password!!")).rejects.toThrow(
      /wrong password/,
    );
    const moved = await Vault.openWithPassword(box, kv, PASSWORD);
    expect(moved.identity.publicKey).toEqual(old.identity.publicKey);
    // The old vault is gone; from now on, the box alone.
    expect(kv.map.has("ekatva.vault")).toBe(false);
    expect((await Vault.open(box, kv)).logKey).toEqual(old.logKey);
  });

  it("finds a vault from before even without its mark (an older build)", async () => {
    const kv = new MemoryKV();
    await kv.set("ekatva.laptops", "[]");
    expect(await Vault.exists(testBox().box, kv)).toBe(true);
    expect(await Vault.exists(testBox().box, new MemoryKV())).toBe(false);
  });

  it("says plainly when Android dropped the key", async () => {
    const { box, drop } = testBox();
    await Vault.create(box);
    drop();
    await expect(Vault.open(box, new MemoryKV())).rejects.toBeInstanceOf(KeyGone);
  });

  it("is gone after starting over", async () => {
    const { box } = testBox();
    const kv = new MemoryKV();
    await Vault.create(box);
    await Vault.wipe(box, kv);
    expect(await Vault.exists(box, kv)).toBe(false);
  });
});

describe("the phone's files", () => {
  it("stays inside the shared folder and undoes deletes and overwrites", async () => {
    const memfs = new MemFs();
    await memfs.mkdir("/sd/docs");
    await memfs.write("/sd/docs/a.txt", Buffer.from("v1").toString("base64"));
    const f = new PhoneFiles(memfs, ["/sd"], "/app/undo");
    const open = { allowPrivate: false };
    await expect(f.list("/data", open)).rejects.toThrow(/outside/);
    await expect(f.list("~/../data", open)).rejects.toThrow(/outside/);
    const w = await f.write(
      { path: "~/docs/a.txt", data: Buffer.from("v2").toString("base64"), mode: "overwrite" },
      open,
    );
    await f.undo(w.undo!);
    expect(memfs.files.get("/sd/docs/a.txt")).toBe("v1");
    const r = await f.remove("~/docs", open);
    expect(memfs.files.has("/sd/docs/a.txt")).toBe(false);
    await f.undo(r.undo!);
    expect(memfs.files.get("/sd/docs/a.txt")).toBe("v1");
  });
});

describe("phone and laptop, end to end", () => {
  let root: string;
  let daemon: Daemon;
  let local: ReturnType<typeof createTRPCClient<LocalRouter>>;
  let ws: ReturnType<typeof createWSClient>;
  let p: ReturnType<typeof platform>;
  let phone: Session;

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ekatva-mobile-"));
    process.env.HOME = join(root, "home");
    await fs.mkdir(process.env.HOME);
    const config = loadConfig(join(root, "none.toml"));
    config.name = "ace";
    daemon = new Daemon({
      config,
      key: generateKeyPair(),
      stateDir: join(root, "home/.local/state/ekatva"),
      configDir: join(root, "home/.config/ekatva"),
      undoDir: join(root, "home/.local/share/ekatva/undo"),
      socketPath: join(root, "ekatva.sock"),
      port: 0,
      host: "127.0.0.1",
      beacon: false,
      checkFirewall: false,
      desktopNotifications: false,
      rendezvous: false,
      jyotiHost: {
        run: async () => ({ code: 0, out: "" }),
        hold: () => ({ stop: async () => undefined, onExit() {} }),
        lock: async () => undefined,
        lidClosed: () => null,
        battery: () => null,
        now: Date.now,
      },
      log: () => undefined,
    });
    await daemon.start();
    ws = createWSClient({
      url: `ws+unix://${join(root, "ekatva.sock")}:/`,
      WebSocket: WebSocket as never,
    });
    local = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
    p = platform();
    phone = await Session.create(p);
  });

  afterAll(async () => {
    phone.link.stop();
    ws.close();
    await daemon.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("pairs by QR, with the same emoji on both sides", async () => {
    const offer = await local.admin.pair.start.mutate({ away: false });
    // The daemon listens on 127.0.0.1 in tests; the QR lists its LAN addresses.
    const uri = offer.uri.replace(/lan=[^&]*/, `lan=127.0.0.1%3A${daemon.port}`);
    const pending = new Promise<{ id: string; sas: string[] }>((resolve) => {
      const sub = local.admin.pair.pending.subscribe(undefined, {
        onData: (l) => {
          if (l[0]) {
            sub.unsubscribe();
            resolve(l[0]);
          }
        },
      });
    });
    let shown: string[] = [];
    const pairing = phone.link.pair(uri, (e) => {
      shown = e;
    });
    const req = await pending;
    await local.admin.pair.confirm.mutate({ id: req.id, accept: true, grants: [] });
    const laptop = await pairing;
    expect(laptop.name).toBe("ace");
    expect(shown).toEqual(req.sas);
    expect(phone.link.state).toMatchObject({ status: "online", via: "lan" });
  });

  it("uses the laptop, and both logs record it", async () => {
    const client = phone.link.client!;
    expect((await client.status.query()).name).toBe("ace");
    await client.files.write.mutate({
      path: "~/from-phone.txt",
      data: Buffer.from("hi").toString("base64"),
      mode: "create",
    });
    const log = await local.admin.log.list.query({ host: "self" });
    expect(log.at(-1)).toMatchObject({ action: "files.write", actor: { name: "Pixel 8" } });
    // The phone reads the laptop's log from the laptop, a page at a time, and keeps no copy.
    const head = await client.journal.head.query();
    expect(head.seq).toBe(log.at(-1)?.seq);
    const page = await client.journal.since.query({ after: head.seq - 1, limit: 5 });
    expect(page.at(-1)).toMatchObject({ action: "files.write" });
    expect(await p.lines(`log-${daemon.id}`).read()).toEqual([]);
  });

  it("answers a root request from the laptop's window, the password never logged", async () => {
    // A stand-in for dvarapala's window on the laptop.
    const win = netConnect(join(root, "ekatva-root.sock"));
    await new Promise((r) => win.once("connect", r));
    const got: string[] = [];
    win.setEncoding("utf8");
    win.on("data", (d: string) => got.push(...d.split("\n").filter(Boolean)));
    win.write(
      `${JSON.stringify({ t: "request", v: 1, via: "anumati", requester: "claude", reason: "install jq", commands: [{ cmd: "pacman -S --noconfirm jq", why: "needed" }] })}\n`,
    );
    const client = phone.link.client!;
    // Not granted by default ("everything but root").
    await expect(client.root.pending.query()).rejects.toThrow(/may not use "root"/);
    await local.admin.devices.grant.mutate({
      key: "Pixel 8",
      grants: ["status", "files", "journal", "root", "phone.notifications"],
    });
    const [r] = await client.root.pending.query();
    expect(r).toMatchObject({
      requester: "claude",
      commands: [{ cmd: "pacman -S --noconfirm jq" }],
    });
    await client.root.respond.mutate({
      id: r!.id,
      approve: true,
      password: "s3cret-pass",
      allow: [0],
    });
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((res) => setTimeout(res, 20));
    expect(JSON.parse(got[0]!)).toEqual({
      t: "answer",
      approve: true,
      allow: [0],
      password: "s3cret-pass",
    });
    win.write(`${JSON.stringify({ t: "done", status: "completed" })}\n`);
    win.end();
    const log = await local.admin.log.list.query({ host: "self" });
    expect(log.at(-1)?.summary).toBe("Approved 1 of 1 root command for claude");
    expect(JSON.stringify(log)).not.toContain("s3cret-pass");
  });

  it("serves the laptop, logging on the phone, mirrored on the laptop", async () => {
    await local.admin.phone.mutate.mutate({ path: "ring" });
    expect(p.rang()).toBe(1);
    expect((await phone.journal.since(0)).at(-1)).toMatchObject({
      action: "ring",
      actor: { name: "ace" },
    });
    await expect(
      local.admin.phone.mutate.mutate({ path: "calls.dial", input: { number: "+911234567890" } }),
    ).rejects.toThrow(/newer build/);
    for (let i = 0; i < 50; i++) {
      if ((await local.admin.log.list.query({ host: "Pixel 8" })).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const copy = await local.admin.log.list.query({ host: "Pixel 8" });
    expect(copy.map((e) => e.action)).toEqual(["ring", "calls.dial"]);
    expect(copy[1]).toMatchObject({ ok: false });
  });

  it("the phone's own grants decide what the laptop may do there", async () => {
    await phone.laptops.update(daemon.id, { grants: ["phone.status"] });
    await expect(local.admin.phone.mutate.mutate({ path: "ring" })).rejects.toThrow(/may not use/);
    expect(p.rang()).toBe(1);
  });

  it("one link per app: starting a second stops the first", async () => {
    const twin = await Session.unlock(p);
    twin.link.start();
    for (let i = 0; i < 100 && twin.link.state.status !== "online"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(twin.link.state.status).toBe("online");
    // The first one stopped for good: it doesn't knock again.
    expect(phone.link.state).toMatchObject({ status: "offline", retryAt: null });
    expect(LinkManager.active).toBe(twin.link);

    // Two copies anyway (two processes): the one replaced waits half a minute.
    LinkManager.active = null;
    phone.link.start();
    for (let i = 0; i < 100 && twin.link.state.status !== "offline"; i++)
      await new Promise((r) => setTimeout(r, 20));
    const s = twin.link.state as { status: string; error: string | null; retryAt: number | null };
    expect(s.error).toMatch(/replaced by a new connection/);
    expect((s.retryAt ?? 0) - Date.now()).toBeGreaterThan(20_000);
    twin.link.stop();
    for (let i = 0; i < 100 && phone.link.state.status !== "online"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(phone.link.state.status).toBe("online");
  });

  it("reconnects by itself, and stops when the laptop unpairs it", async () => {
    // Drop the connection from the laptop's side.
    await local.admin.devices.grant.mutate({ key: "Pixel 8", grants: ["status", "journal"] });
    const states: string[] = [];
    phone.link.subscribe((s) => states.push(s.status));
    await local.admin.devices.unpair.mutate({ key: "Pixel 8" });
    for (
      let i = 0;
      i < 100 && !(phone.link.state.status === "offline" && phone.link.state.retryAt === null);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(phone.link.state).toMatchObject({ status: "offline", retryAt: null });
    expect((phone.link.state as { error: string }).error).toMatch(/no longer knows this phone/);
    expect(states).toContain("connecting");
  });
});
