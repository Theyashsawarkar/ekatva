/**
 * ekatva: the command line. `ekatva daemon` is the service; everything
 * else talks to it over its local socket.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  CAPABILITIES,
  type CaffeineLevel,
  type Entry,
  type LocalRouter,
  PRESETS,
  type Preset,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, TRPCClientError, wsLink } from "@trpc/client";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { Daemon, VERSION } from "./daemon.js";
import { loadIdentity } from "./identity.js";
import { dirs, socketPath } from "./paths.js";
import { run } from "./services/system.js";

const HELP = `ekatva ${VERSION}: your phone and your laptop as one device

  ekatva pair [--grants PRESET]   show a QR code for the phone to scan
  ekatva devices                  paired phones, online or not
  ekatva grant DEVICE WHAT        what a phone may do: a preset or capabilities
  ekatva unpair DEVICE            forget a phone (undoable)
  ekatva log [DEVICE] [-n N]      the action log (this laptop's, or a phone's copy)
  ekatva undo N                   undo entry #N of this laptop's log
  ekatva check                    verify both logs' hash chains
  ekatva caffeine [off|on|high] [--for MIN]
  ekatva status [--json|--waybar]
  ekatva agents                   AI agent sessions in tmux
  ekatva window [TAB]             open the desktop window (phones, log, caffeine, phone)
  ekatva daemon                   run the service (systemd does this)

Presets: ${Object.keys(PRESETS).join(", ")}
Capabilities: ${Object.keys(CAPABILITIES)
  .filter((c) => c !== "admin")
  .join(", ")}`;

function client() {
  if (!existsSync(socketPath()))
    fail("the ekatva service isn't running (systemctl --user start ekatva)");
  // A stuck service shouldn't hang the shell.
  setTimeout(() => fail("the ekatva service didn't answer"), 15_000).unref();
  const ws = createWSClient({
    url: `ws+unix://${socketPath()}:/`,
    WebSocket: WebSocket as never,
    retryDelayMs: () => 1e9,
    onError: () => undefined,
  });
  return {
    api: createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] }),
    close: () => ws.close(),
  };
}

function fail(msg: string): never {
  process.stderr.write(`ekatva: ${msg}\n`);
  process.exit(1);
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The fields of a log entry the CLI prints. */
type Logged = Pick<Entry, "seq" | "at" | "actor" | "summary" | "ok" | "error" | "undoes"> & {
  undo?: unknown;
};

function printEntry(e: Logged): void {
  const mark = e.undoes ? "↶" : e.ok ? (e.undo ? "•" : "·") : "✗";
  process.stdout.write(
    `${String(e.seq).padStart(5)} ${mark} ${when(Date.parse(e.at))}  ${e.actor.name.padEnd(10)} ${e.summary}${e.error && !e.ok ? `  (${e.error})` : ""}\n`,
  );
}

async function pair(api: ReturnType<typeof client>["api"], preset: string): Promise<void> {
  const grants = preset in PRESETS ? [...PRESETS[preset as Preset]] : fail(`no preset "${preset}"`);
  const offer = await api.admin.pair.start.mutate({ away: false });
  const qr = await import("qrcode-terminal");
  qr.default.generate(offer.uri, { small: true }, (s: string) => process.stdout.write(`${s}\n`));
  process.stdout.write(
    `Scan this with the ekatva app. It works once, for 2 minutes.\n${offer.lan.length ? `On this network at ${offer.lan.join(", ")}` : "No network address found: is Wi-Fi on?"}\n\nWaiting for the phone…\n`,
  );
  const pending = await new Promise<{ id: string; name: string; sas: string[] }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no phone came in 2 minutes; run it again")),
        offer.expires - Date.now(),
      );
      const sub = api.admin.pair.pending.subscribe(undefined, {
        onData: (list) => {
          if (list[0]) {
            clearTimeout(timer);
            sub.unsubscribe();
            resolve(list[0]);
          }
        },
        onError: reject,
      });
    },
  );
  process.stdout.write(
    `\n${pending.name} is asking to pair. It should show:\n\n      ${pending.sas.join("   ")}\n\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Do they match? [y/N] ")).trim().toLowerCase();
  rl.close();
  const ok = answer === "y" || answer === "yes";
  await api.admin.pair.confirm.mutate({ id: pending.id, accept: ok, grants });
  process.stdout.write(
    ok
      ? `Paired ${pending.name} (${preset}). Change it with: ekatva grant "${pending.name}" …\n`
      : "Refused.\n",
  );
}

/**
 * Opens the Electron window, detached. GTK 4 preloaded into the environment
 * (gtk4-layer-shell, for Vyom's panels) would crash Electron's GTK 3, so
 * it's taken out for this child.
 */
async function openWindow(tab: string | undefined): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const desktop =
    process.env.EKATVA_DESKTOP ?? join(dirname(fileURLToPath(import.meta.url)), "../../desktop");
  const electron = join(desktop, "node_modules/electron/dist/electron");
  if (!existsSync(electron) || !existsSync(join(desktop, "out/main/index.js")))
    fail(`the desktop window isn't built (${desktop}); run pnpm build`);
  const env = { ...process.env };
  const preload = (env.LD_PRELOAD ?? "")
    .split(/[: ]/)
    .filter((p) => p && !p.includes("gtk4-layer-shell"));
  if (preload.length) env.LD_PRELOAD = preload.join(":");
  else delete env.LD_PRELOAD;
  const args = [
    join(desktop, "out/main/index.js"),
    "--ozone-platform-hint=auto",
    ...(tab ? [`--tab=${tab}`] : []),
  ];
  spawn(electron, args, { env, detached: true, stdio: "ignore" }).unref();
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd === "window") {
    await openWindow(rest[0]);
    return;
  }
  if (cmd === "daemon") {
    const config = loadConfig();
    const { key, where } = await loadIdentity(dirs.state(), (m) => console.error(m));
    const notify = (title: string, body: string, urgent?: boolean) =>
      void run("notify-send", [
        "-a",
        "ekatva",
        ...(urgent ? ["-u", "critical"] : []),
        title,
        body,
      ]).catch(() => undefined);
    const d = new Daemon({
      config,
      key,
      stateDir: dirs.state(),
      configDir: dirs.config(),
      undoDir: dirs.undo(),
      socketPath: socketPath(),
      notify,
    });
    await d.start();
    console.error(`identity in the ${where}`);
    const stop = () => void d.stop().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }

  const { api, close } = client();
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  try {
    switch (cmd) {
      case "pair":
        await pair(api, flag("--grants") ?? "everything-but-root");
        break;
      case "devices": {
        const list = await api.admin.devices.list.query();
        if (!list.length) process.stdout.write("No paired phones. Pair one with: ekatva pair\n");
        for (const d of list) {
          process.stdout.write(
            `${d.online ? "●" : "○"} ${d.name}  ${d.online ? `connected (${d.via})` : d.lastSeen ? `last seen ${when(d.lastSeen)}` : "never connected"}\n    may: ${d.grants.join(", ") || "nothing"}\n`,
          );
        }
        break;
      }
      case "grant": {
        const [device, ...what] = rest;
        if (!device || !what.length) fail("usage: ekatva grant DEVICE PRESET|CAPABILITY…");
        const grants =
          what.length === 1 && what[0] && what[0] in PRESETS
            ? [...PRESETS[what[0] as Preset]]
            : what.flatMap((w) => w.split(","));
        const d = await api.admin.devices.grant.mutate({ key: device, grants });
        process.stdout.write(`${d.name} may: ${d.grants.join(", ") || "nothing"}\n`);
        break;
      }
      case "unpair": {
        if (!rest[0]) fail("usage: ekatva unpair DEVICE");
        await api.admin.devices.unpair.mutate({ key: rest[0] });
        process.stdout.write(
          `Unpaired ${rest[0]}. Undo it with \`ekatva log\` and \`ekatva undo N\`.\n`,
        );
        break;
      }
      case "log": {
        const n = Number(flag("-n") ?? 30);
        const host = rest[0] ?? "self";
        const all: Logged[] = [];
        for (let after = 0; ; ) {
          const batch = await api.admin.log.list.query({ host, after, limit: 1000 });
          all.push(...batch);
          if (batch.length < 1000) break;
          after = batch.at(-1)?.seq ?? after;
        }
        for (const e of all.slice(-n)) printEntry(e);
        if (!all.length) process.stdout.write("Nothing yet.\n");
        else
          process.stdout.write(
            "\n• undoable   · can't be undone   ✗ failed or refused   ↶ an undo\n",
          );
        break;
      }
      case "undo": {
        const seq = Number(rest[0]);
        if (!Number.isInteger(seq) || seq < 1) fail("usage: ekatva undo N (see `ekatva log`)");
        const r = await api.journal.undo.mutate({ seq });
        process.stdout.write(`${r.summary}\n`);
        break;
      }
      case "check": {
        let bad = false;
        for (const c of await api.admin.log.check.query()) {
          bad ||= c.problem !== null;
          process.stdout.write(
            `${c.problem ? "✗" : "✓"} ${c.host === "self" ? `${c.name} (this laptop)` : c.name}: ${c.seq} entries${c.problem ? `, ${c.problem}` : ", intact"}\n`,
          );
        }
        if (bad) process.exitCode = 2;
        break;
      }
      case "caffeine": {
        const level = rest[0] as CaffeineLevel | undefined;
        if (level && !["off", "on", "high"].includes(level))
          fail("usage: ekatva caffeine [off|on|high] [--for MIN]");
        const minutes = flag("--for");
        const c = level
          ? await api.caffeine.set.mutate({ level, minutes: minutes ? Number(minutes) : null })
          : await api.caffeine.get.query();
        process.stdout.write(`caffeine: ${c.level}${c.until ? ` until ${when(c.until)}` : ""}\n`);
        break;
      }
      case "status": {
        const [s, devices] = await Promise.all([
          api.status.query(),
          api.admin.devices.list.query(),
        ]);
        const online = devices.filter((d) => d.online);
        if (rest.includes("--waybar")) {
          const text = online.length ? online.map((d) => d.name).join(", ") : "";
          process.stdout.write(
            `${JSON.stringify({ text, tooltip: `${online.length} phone(s) connected · caffeine ${s.caffeine} · ${s.waiting} agent(s) waiting`, class: [online.length ? "connected" : "idle", `caffeine-${s.caffeine}`] })}\n`,
          );
        } else if (rest.includes("--json"))
          process.stdout.write(`${JSON.stringify({ ...s, devices })}\n`);
        else
          process.stdout.write(
            `${s.name}: caffeine ${s.caffeine}, ${s.waiting} agent(s) waiting, ${online.length ? `connected: ${online.map((d) => d.name).join(", ")}` : "no phone connected"}\n`,
          );
        break;
      }
      case "agents": {
        const list = await api.agents.list.query();
        if (!list.length) process.stdout.write("No agent sessions in tmux.\n");
        for (const a of list) {
          process.stdout.write(
            `${a.id.padEnd(5)} ${a.session.padEnd(16)} ${a.state.padEnd(8)} ${a.project}\n`,
          );
          if (a.question)
            process.stdout.write(
              `      ? ${a.question.text}  ${a.question.options.map((o) => `[${o.key}] ${o.label}`).join("  ")}\n`,
            );
        }
        break;
      }
      default:
        fail(`no command "${cmd}"; see ekatva --help`);
    }
  } catch (e) {
    if (e instanceof TRPCClientError) fail(e.message);
    if (
      (e as { code?: string }).code === "ENOENT" ||
      /ECONNREFUSED|ENOENT|closed/.test(String(e))
    ) {
      fail("the ekatva service isn't running (systemctl --user start ekatva)");
    }
    throw e;
  } finally {
    close();
  }
}

const argv = process.argv.slice(2);
main(argv).then(
  () => {
    // The daemon runs on; a command is done once it has printed.
    if (argv[0] !== "daemon") process.exit(process.exitCode ?? 0);
  },
  (e) => fail((e as Error).message),
);
