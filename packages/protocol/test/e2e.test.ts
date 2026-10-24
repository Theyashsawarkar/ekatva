import { accept, connect, generateKeyPair, PORT_LAPTOP, toB64u } from "@ekatva/link";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import { pipe } from "../../link/test/memory.js";
import { ALL, type Capability } from "../src/capabilities.js";
import type { Done, FileEntry, FileService } from "../src/files.js";
import { Journal, MemoryStore, Mirror, redact, verify } from "../src/journal.js";
import { type LaptopRouter, type LaptopServices, laptopRouter } from "../src/laptop.js";
import { channelWebSocket, serveRouter } from "../src/rpc.js";

/** An in-memory filesystem whose deletes and overwrites go to a trash, like the daemon's. */
function memoryFiles() {
  const files = new Map<string, string>();
  const trash = new Map<string, { path: string; data: string }>();
  let n = 0;
  const entry = (path: string): FileEntry => ({
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file",
    size: files.get(path)?.length ?? 0,
    mtime: 0,
  });
  const keep = (path: string) => {
    const id = `t${++n}`;
    trash.set(id, { path, data: files.get(path) as string });
    return id;
  };
  const service: FileService = {
    async list() {
      return [...files.keys()].map(entry);
    },
    async stat(path) {
      if (!files.has(path)) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return entry(path);
    },
    async read({ path }) {
      const data = files.get(path);
      if (data === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return { data, size: data.length, eof: true };
    },
    async write({ path, data, mode }) {
      const existed = files.has(path);
      if (existed && mode === "create")
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const undo = existed
        ? { kind: "files.restore", data: { id: keep(path), path } }
        : { kind: "files.trash", data: { path } };
      files.set(path, mode === "append" ? (files.get(path) ?? "") + data : data);
      return { value: entry(path), summary: `Wrote ${path}`, undo };
    },
    async mkdir(path) {
      return { value: entry(path), summary: `Made ${path}` };
    },
    async move() {
      throw new Error("unused");
    },
    async copy() {
      throw new Error("unused");
    },
    async remove(path) {
      if (!files.has(path)) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      const id = keep(path);
      files.delete(path);
      return {
        value: null,
        summary: `Deleted ${path}`,
        undo: { kind: "files.restore", data: { id, path } },
      };
    },
  };
  const undo = async (u: { kind: string; data: unknown }): Promise<Done<unknown>> => {
    if (u.kind === "files.restore") {
      const { id, path } = u.data as { id: string; path: string };
      const t = trash.get(id);
      if (!t) throw new Error("gone from the undo store");
      const redo = files.has(path)
        ? { kind: "files.restore", data: { id: keep(path), path } }
        : { kind: "files.trash", data: { path } };
      files.set(path, t.data);
      trash.delete(id);
      return { value: null, summary: `Restored ${path}`, undo: redo };
    }
    if (u.kind === "files.trash") {
      const { path } = u.data as { path: string };
      const id = keep(path);
      files.delete(path);
      return {
        value: null,
        summary: `Removed ${path}`,
        undo: { kind: "files.restore", data: { id, path } },
      };
    }
    throw new Error(`can't undo ${u.kind}`);
  };
  return { files, service, undo };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function setup(grants: Capability[]) {
  const laptopKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const [pt, lt] = pipe();
  const journal = new Journal(new MemoryStore(), toB64u(laptopKey.publicKey));
  const fs = memoryFiles();
  const services = {
    status: async () => ({
      name: "ace",
      battery: { percent: 64, charging: true },
      cpu: 12,
      temperature: 41,
      uptime: 3600,
      caffeine: "off",
      waiting: 1,
      locked: false,
    }),
    files: fs.service,
    undo: fs.undo,
    root: null,
  } as unknown as LaptopServices;
  const laptopSide = accept(lt, {
    me: laptopKey,
    hello: { v: 1, name: "ace" },
    authorize: () => ({ ok: true }),
    keepaliveMs: 0,
  });
  const { channel: phone } = await connect(pt, {
    me: phoneKey,
    expect: laptopKey.publicKey,
    hello: { v: 1, name: "Pixel" },
    keepaliveMs: 0,
  });
  const laptop = await laptopSide;
  serveRouter({
    router: laptopRouter,
    channel: laptop,
    port: PORT_LAPTOP,
    createContext: () => ({
      actor: { key: toB64u(phoneKey.publicKey), name: "Pixel" },
      grants: new Set(grants),
      journal,
      services,
    }),
  });
  const ws = createWSClient({ url: "ekatva:", WebSocket: channelWebSocket(phone, PORT_LAPTOP) });
  const client = createTRPCClient<LaptopRouter>({ links: [wsLink({ client: ws })] });
  closers.push(() => {
    ws.close();
    phone.close();
  });
  return { client, journal, fs };
}

describe("the laptop's API over the encrypted channel", () => {
  it("answers a query with a real tRPC client", async () => {
    const { client, journal } = await setup(["status"]);
    expect((await client.status.query()).battery?.percent).toBe(64);
    // Polling the state isn't an action worth recording.
    expect(await journal.since(0)).toHaveLength(0);
  });

  it("refuses what isn't granted, and records the refusal", async () => {
    const { client, journal } = await setup(["status"]);
    await expect(client.files.remove.mutate({ path: "/x" })).rejects.toMatchObject({
      data: { code: "FORBIDDEN" },
    });
    const [e] = await journal.since(0);
    expect(e).toMatchObject({
      action: "files.remove",
      ok: false,
      error: "not granted",
      actor: { name: "Pixel" },
    });
  });

  it("records changes and reads, then undoes and redoes a delete", async () => {
    const { client, journal, fs } = await setup(ALL);
    await client.files.write.mutate({ path: "/notes.md", data: "v1", mode: "create" });
    await client.files.write.mutate({ path: "/notes.md", data: "v2", mode: "overwrite" });
    expect((await client.files.read.query({ path: "/notes.md" })).data).toBe("v2");
    await client.files.remove.mutate({ path: "/notes.md" });
    expect(fs.files.has("/notes.md")).toBe(false);

    const log = await journal.since(0);
    expect(log.map((e) => e.action)).toEqual([
      "files.write",
      "files.write",
      "files.read",
      "files.remove",
    ]);
    // File contents never reach the journal.
    expect(log[0]?.input).toEqual({
      path: "/notes.md",
      data: { redacted: true, length: 2 },
      mode: "create",
    });
    expect(verify(log)).toBeNull();

    const del = log[3]?.seq as number;
    expect(await client.journal.undo.mutate({ seq: del })).toMatchObject({ undid: del });
    expect(fs.files.get("/notes.md")).toBe("v2");
    await expect(client.journal.undo.mutate({ seq: del })).rejects.toMatchObject({
      data: { code: "CONFLICT" },
    });

    // Undo the overwrite: back to v1.
    expect(await client.journal.undo.mutate({ seq: log[1]?.seq as number })).toBeTruthy();
    expect(fs.files.get("/notes.md")).toBe("v1");

    // The undo of the delete is itself undoable: a redo.
    const after = await journal.since(0);
    const undoEntry = after.find((e) => e.undoes === del);
    expect(undoEntry?.undo).toBeTruthy();
    expect(await journal.check()).toBeNull();
  });

  it("streams the journal live to a subscriber", async () => {
    const { client, journal } = await setup(ALL);
    await client.files.write.mutate({ path: "/a", data: "1", mode: "create" });
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      const sub = client.journal.follow.subscribe(
        { after: 0 },
        {
          onData: (e) => {
            seen.push(e.seq);
            if (seen.length === 2) {
              sub.unsubscribe();
              resolve();
            }
          },
        },
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    await journal.record({
      actor: { key: "local", name: "yash" },
      action: "test",
      summary: "t",
      input: null,
      ok: true,
    });
    await done;
    expect(seen).toEqual([1, 2]);
  });

  it("rejects bad input with tRPC's validation", async () => {
    const { client } = await setup(ALL);
    await expect(
      client.files.write.mutate({ path: "", data: "", mode: "create" }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
  });
});

describe("journal", () => {
  const actor = { key: "phone", name: "Pixel" };
  it("detects an altered, removed or reordered entry", async () => {
    const j = new Journal(new MemoryStore(), "laptop");
    for (const i of [1, 2, 3])
      await j.record({ actor, action: "x", summary: `${i}`, input: { i }, ok: true });
    const log = await j.since(0);
    expect(verify(log)).toBeNull();
    expect(verify([{ ...(log[0] as never), summary: "changed" }, ...log.slice(1)])?.why).toBe(
      "altered",
    );
    expect(verify([log[0], log[2]] as never)?.seq).toBe(3);
    expect(verify([log[1], log[0], log[2]] as never)).not.toBeNull();
  });

  it("mirrors the other device's chain, refusing rewrites and strangers", async () => {
    const theirs = new Journal(new MemoryStore(), "phone");
    for (const i of [1, 2])
      await theirs.record({ actor, action: "x", summary: `${i}`, input: null, ok: true });
    const mirror = new Mirror(new MemoryStore(), "phone");
    expect(await mirror.add(await theirs.since(0))).toBeNull();
    expect(await mirror.add(await theirs.since(0))).toBeNull(); // a resend is fine
    await theirs.record({ actor, action: "x", summary: "3", input: null, ok: true });
    expect(await mirror.add(await theirs.since(2))).toBeNull();
    expect(await mirror.head()).toBe(3);
    const forged = (await theirs.since(0)).map((e) =>
      e.seq === 2 ? { ...e, summary: "forged", hash: "x" } : e,
    );
    expect((await mirror.add(forged))?.why).toBe("history was rewritten");
    const other = new Journal(new MemoryStore(), "evil");
    await other.record({ actor, action: "x", summary: "1", input: null, ok: true });
    expect((await mirror.add(await other.since(0)))?.why).toBe("another device's entry");
  });

  it("redacts secrets and bulk content", () => {
    expect(
      redact({
        id: "r1",
        approve: true,
        password: "hunter2",
        nested: { apiToken: "abc", text: "hello" },
      }),
    ).toEqual({
      id: "r1",
      approve: true,
      password: "[redacted]",
      nested: { apiToken: "[redacted]", text: { redacted: true, length: 5 } },
    });
  });

  it("knows every procedure's capability, for undo", () => {
    const procs = laptopRouter._def.procedures as unknown as Record<
      string,
      { _def: { meta?: { cap: string } } }
    >;
    expect(procs["files.remove"]?._def.meta?.cap).toBe("files");
    for (const [path, p] of Object.entries(procs)) expect(p._def.meta?.cap, path).toBeTruthy();
  });
});
