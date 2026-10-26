import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  generateKeyPair,
  PORT_LAPTOP,
  PORT_PHONE,
  parseOffer,
  toB64u,
  webSocketTransport,
} from "@ekatva/link";
import {
  channelWebSocket,
  Journal,
  type LaptopRouter,
  type LocalRouter,
  MemoryStore,
  type PhoneServices,
  phoneRouter,
  serveRouter,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import type { Host } from "../src/services/caffeine.js";

let root: string;
let daemon: Daemon;
let local: ReturnType<typeof createTRPCClient<LocalRouter>>;
const closers: (() => void)[] = [];

const fakeHost: Host = {
  run: async () => ({ code: 0, out: "" }),
  hold: () => ({ stop: () => undefined, onExit: () => undefined }),
  lidClosed: () => null,
  battery: () => null,
  now: () => Date.now(),
};

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ekatva-daemon-"));
  const home = join(root, "home");
  await fs.mkdir(home);
  process.env.HOME = home;
  await fs.writeFile(join(home, "notes.md"), "keep me");
  const config = loadConfig(join(root, "none.toml"));
  config.name = "ace";
  daemon = new Daemon({
    config,
    key: generateKeyPair(),
    stateDir: join(home, ".local/state/ekatva"),
    configDir: join(home, ".config/ekatva"),
    undoDir: join(home, ".local/share/ekatva/undo"),
    socketPath: join(root, "ekatva.sock"),
    port: 0,
    host: "127.0.0.1",
    mdns: false,
    rendezvous: false,
    caffeineHost: fakeHost,
    log: () => undefined,
  });
  await daemon.start();
  const ws = createWSClient({
    url: `ws+unix://${join(root, "ekatva.sock")}:/`,
    WebSocket: WebSocket as never,
  });
  local = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
  closers.push(() => ws.close());
});

afterAll(async () => {
  for (const c of closers.splice(0)) c();
  await daemon.stop();
  await fs.rm(root, { recursive: true, force: true });
});

/** A phone, in Node: connects over a real WebSocket, serves its own API, keeps its own log. */
async function phone(opts: {
  token?: Uint8Array;
  key?: ReturnType<typeof generateKeyPair>;
  laptopKey: Uint8Array;
}) {
  const me = opts.key ?? generateKeyPair();
  const sock = new WebSocket(`ws://127.0.0.1:${daemon.port}/link`);
  await new Promise((r, j) => {
    sock.once("open", r);
    sock.once("error", j);
  });
  let emoji: string[] = [];
  const { channel } = await connect(webSocketTransport(sock as never), {
    me,
    expect: opts.laptopKey,
    hello: {
      v: 1,
      name: "Pixel 8",
      ...(opts.token ? { token: toB64u(opts.token) } : {}),
      info: { app: "test" },
    },
    onSas: (e) => {
      emoji = e;
    },
    keepaliveMs: 0,
  });
  const journal = new Journal(new MemoryStore(), toB64u(me.publicKey));
  let rang = 0;
  const services = {
    ring: async () => {
      rang++;
      return { value: null, summary: "Rang the phone" };
    },
    undo: async () => {
      throw new Error("nothing to undo");
    },
  } as unknown as PhoneServices;
  serveRouter({
    router: phoneRouter,
    channel,
    port: PORT_PHONE,
    createContext: () => ({
      actor: { key: daemon.id, name: "ace" },
      grants: { has: () => true },
      journal,
      services,
    }),
  });
  const ws = createWSClient({ url: "ekatva:", WebSocket: channelWebSocket(channel, PORT_LAPTOP) });
  const client = createTRPCClient<LaptopRouter>({ links: [wsLink({ client: ws })] });
  closers.push(() => {
    ws.close();
    channel.close();
  });
  return { me, channel, client, journal, emoji: () => emoji, rang: () => rang };
}

const laptopKeyFrom = async () =>
  parseOffer((await local.admin.pair.start.mutate({ away: false })).uri);

describe("the daemon, end to end", () => {
  let p: Awaited<ReturnType<typeof phone>>;

  it("pairs a phone after you confirm matching emoji", async () => {
    const offer = await laptopKeyFrom();
    expect(offer.name).toBe("ace");
    const seen = new Promise<{ id: string; sas: string[] }>((resolve) => {
      const sub = local.admin.pair.pending.subscribe(undefined, {
        onData: (list) => {
          if (list[0]) {
            sub.unsubscribe();
            resolve(list[0]);
          }
        },
      });
    });
    const connecting = phone({ token: offer.token, laptopKey: offer.key });
    const pending = await seen;
    await local.admin.pair.confirm.mutate({
      id: pending.id,
      accept: true,
      grants: ["status", "files", "journal", "phone.notifications"],
    });
    p = await connecting;
    expect(p.emoji()).toEqual(pending.sas);
    const devices = await local.admin.devices.list.query();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: "Pixel 8", online: true, via: "lan" });
  });

  it("serves the phone what it was granted, and logs it", async () => {
    expect((await p.client.status.query()).name).toBe("ace");
    await expect(p.client.caffeine.set.mutate({ level: "high" })).rejects.toMatchObject({
      data: { code: "FORBIDDEN" },
    });
    await p.client.files.remove.mutate({ path: "~/notes.md" });
    await expect(fs.readFile(join(root, "home/notes.md"), "utf8")).rejects.toThrow();
    const log = await local.admin.log.list.query({ host: "self" });
    const del = log.find((e) => e.action === "files.remove");
    expect(del).toMatchObject({ ok: true, actor: { name: "Pixel 8" } });
    expect(log.find((e) => e.action === "caffeine.set")).toMatchObject({
      ok: false,
      error: "not granted",
    });
    // The phone undoes its own delete.
    await p.client.journal.undo.mutate({ seq: del!.seq });
    expect(await fs.readFile(join(root, "home/notes.md"), "utf8")).toBe("keep me");
  });

  it("can't reach ekatva's own state through files", async () => {
    await expect(
      p.client.files.list.query({ path: "~/.local/state/ekatva" }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  it("a revoked grant stops the very next call", async () => {
    await local.admin.devices.grant.mutate({ key: "Pixel 8", grants: ["status", "journal"] });
    await expect(p.client.files.list.query({ path: "~" })).rejects.toMatchObject({
      data: { code: "FORBIDDEN" },
    });
    // And that change is in the log, undoable.
    const log = await local.admin.log.list.query({ host: "self" });
    const change = log.findLast((e) => e.action === "admin.devices.grant");
    expect(change?.summary).toMatch(/no longer: files/);
    await local.journal.undo.mutate({ seq: change!.seq });
    expect((await p.client.files.list.query({ path: "~" })).length).toBeGreaterThan(0);
  });

  it("asks the phone to act, and mirrors the phone's log", async () => {
    await local.admin.phone.mutate.mutate({ path: "ring" });
    expect(p.rang()).toBe(1);
    expect((await p.journal.since(0))[0]).toMatchObject({ action: "ring", actor: { name: "ace" } });
    // The laptop keeps a verified copy of the phone's log.
    for (let i = 0; i < 50; i++) {
      if ((await local.admin.log.list.query({ host: "Pixel 8" })).length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await local.admin.log.list.query({ host: "Pixel 8" })).toHaveLength(1);
    const checks = await local.admin.log.check.query();
    expect(checks.every((c) => c.problem === null)).toBe(true);
  });

  it("refuses a phone it doesn't know, and a spent pairing code", async () => {
    const offer = await laptopKeyFrom();
    await expect(phone({ laptopKey: offer.key })).rejects.toThrow(/isn't paired/);
    const again = parseOffer((await local.admin.pair.start.mutate({ away: false })).uri);
    const sub = local.admin.pair.pending.subscribe(undefined, {
      onData: (list) => {
        if (list[0])
          void local.admin.pair.confirm.mutate({ id: list[0].id, accept: false, grants: [] });
      },
    });
    await expect(phone({ token: again.token, laptopKey: again.key })).rejects.toThrow(
      /refused on the laptop/,
    );
    await expect(phone({ token: again.token, laptopKey: again.key })).rejects.toThrow(
      /used or has expired/,
    );
    sub.unsubscribe();
  });

  it("unpairing drops the connection at once", async () => {
    const closed = new Promise<string>((r) => p.channel.onClose(r));
    await local.admin.devices.unpair.mutate({ key: "Pixel 8" });
    await closed;
    expect(await local.admin.devices.list.query()).toHaveLength(0);
  });
});
