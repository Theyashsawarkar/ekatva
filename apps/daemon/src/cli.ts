/**
 * ekatva: the command line. `ekatva daemon` is the service; everything
 * else talks to it over its local socket.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  CAPABILITIES,
  type CallNow,
  type Entry,
  type JyotiLevel,
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
import { callFor } from "./services/calls.js";
import { run } from "./services/system.js";

/** How long `pair` waits past the code's expiry for a phone that got in at the last moment. */
const PAIR_GRACE_MS = 20_000;

const HELP = `ekatva ${VERSION}: your phone and your laptop as one device

  ekatva pair [--grants PRESET] [--lan] [--window]
                                  show a QR code for the phone to scan, through a tunnel so it
                                  works from any network (--lan: this Wi-Fi only;
                                  --window: in an image window, for terminals that blur it)
  ekatva devices                  paired phones, online or not
  ekatva grant DEVICE WHAT        what a phone may do: a preset or capabilities
  ekatva unpair DEVICE            forget a phone (undoable)
  ekatva log [DEVICE] [-n N]      the action log (this laptop's, or a phone's copy)
  ekatva undo N                   undo entry #N of this laptop's log
  ekatva check                    verify both logs' hash chains
  ekatva appearance [light|dark|toggle]
                                  the laptop's light or dark mode: show it, or switch it
  ekatva phone appearance [light|dark]
                                  the same for the connected phone
  ekatva jyoti [shanta|akhanda|nandadipa] [--for MIN]
                                  keep the laptop awake: akhanda (no lock or sleep), nandadipa
                                  (also with the lid closed); shanta: at rest, as usual
  ekatva call [hangup|--waybar]   the phone's call now (or hang it up; --waybar: a bar capsule)
  ekatva status [--json|--waybar]
  ekatva agents                   AI agent sessions in tmux
  ekatva window [PLACE]           open the window: overview, messages, calls, files, log, devices, pair
  ekatva daemon                   run the service (systemd does this)
  ekatva mcp                      an MCP server on stdio, for AI agents (EKATVA_AGENT=name)

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

async function pair(
  api: ReturnType<typeof client>["api"],
  preset: string,
  away: boolean,
  window: boolean,
): Promise<void> {
  const grants = preset in PRESETS ? [...PRESETS[preset as Preset]] : fail(`no preset "${preset}"`);
  const offer = await api.admin.pair.start.mutate({ away });
  // The QR holds the one-time token: the image lives in the 0700 runtime dir, 0600, and goes when pairing ends.
  const png = join(dirs.runtime(), "ekatva-pair.png");
  let viewer: ReturnType<typeof spawn> | undefined;
  if (window) {
    await run("qrencode", ["-o", png, "-s", "12", "-m", "4"], offer.uri);
    chmodSync(png, 0o600);
    viewer = spawn("swayimg", [png], { stdio: "ignore" });
  } else {
    const qr = await import("qrcode-terminal");
    qr.default.generate(offer.uri, { small: true }, (s: string) => process.stdout.write(`${s}\n`));
  }
  const cleanup = () => {
    viewer?.kill();
    rmSync(png, { force: true });
  };
  try {
    process.stdout.write(
      `Scan this with the ekatva app. It works once, for 2 minutes.\n${offer.lan.length ? `On this network at ${offer.lan.join(", ")}` : "No network address found: is Wi-Fi on?"}${offer.url ? `\nFrom anywhere through ${offer.url}` : ""}\n\nWaiting for the phone…\n`,
    );
    const pending = await new Promise<{ id: string; name: string; sas: string[] }>(
      (resolve, reject) => {
        // A phone that got in just before the code expired is still waiting for an answer.
        const timer = setTimeout(
          () => reject(new Error("no phone came in 2 minutes; run it again")),
          offer.expires - Date.now() + PAIR_GRACE_MS,
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
    viewer?.kill();
    process.stdout.write(
      `\n${pending.name} is asking to pair. It should show:\n\n      ${pending.sas.join("   ")}\n\n`,
    );
    const ok = await decide(pending, window);
    await api.admin.pair.confirm.mutate({ id: pending.id, accept: ok, grants });
    process.stdout.write(
      ok
        ? `Paired ${pending.name} (${preset}). Change it with: ekatva grant "${pending.name}" …\n`
        : "Refused.\n",
    );
  } finally {
    cleanup();
  }
}

/** Asks whether the emoji match: in the terminal, and with --window also in a dialog; the first answer wins. */
async function decide(pending: { name: string; sas: string[] }, window: boolean): Promise<boolean> {
  const stop = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = rl
    .question("Do they match? [y/N] ", { signal: stop.signal })
    .then((a) => ["y", "yes"].includes(a.trim().toLowerCase()));
  const answers = [typed];
  let dialog: ReturnType<typeof spawn> | undefined;
  if (window) {
    dialog = spawn(
      "zenity",
      [
        "--question",
        "--title=ekatva: pair a phone",
        `--text=<big>${pending.sas.join("  ")}</big>\n\nDoes ${pending.name.replace(/[<>&]/g, "")} show these four?\nPair only if they match.`,
        "--ok-label=Pair",
        "--cancel-label=Refuse",
        "--icon=phone",
      ],
      { stdio: "ignore" },
    );
    answers.push(
      new Promise((resolve) => {
        dialog?.on("exit", (code) => resolve(code === 0));
        dialog?.on("error", () => undefined);
      }),
    );
  }
  try {
    return await Promise.race(answers);
  } finally {
    stop.abort();
    rl.close();
    dialog?.kill();
    typed.catch(() => undefined);
  }
}

/** The old window's tabs, as the popup's places. */
/** Jyoti's levels as the CLI says them (ASCII: scripts read them). */
const LEVEL_NAME: Record<JyotiLevel, string> = { off: "shanta", on: "akhanda", high: "nandadipa" };
const LEVEL_WORDS: Record<string, JyotiLevel> = {
  shanta: "off",
  off: "off",
  akhanda: "on",
  on: "on",
  nandadipa: "high",
  nanda: "high",
  strong: "high",
  high: "high",
};

const PLACES: Record<string, string> = {
  phones: "devices",
  devices: "devices",
  pair: "pair",
  log: "log",
  jyoti: "over",
  phone: "over",
  overview: "over",
  messages: "msgs",
  calls: "calls",
  files: "files",
};

/**
 * Opens ekatva's window: Darpaṇa, a Vyom popup (instant, Vyom is resident).
 */
async function openWindow(tab: string | undefined): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const args = ["darpana", ...(tab ? [PLACES[tab] ?? tab] : [])];
  // ~/.local/bin first: the service's and sway's PATH often leave it out.
  for (const vyom of [`${homedir()}/.local/bin/vyom`, "vyom"]) {
    const r = spawnSync(vyom, args, { stdio: "ignore" });
    if (!r.error && r.status === 0) return;
  }
  throw new Error(
    "the window is Darpaṇa, a Vyom popup: install Vyom and Darpaṇa " +
      "(kosha install darpana, or https://github.com/Theyashsawarkar/darpana)",
  );
}

/**
 * `ekatva call --waybar`: the call in progress as a waybar capsule, one JSON
 * line per change and every few seconds while it lasts (for its time), an
 * empty one when there's none (waybar hides it). Runs for as long as waybar
 * does: no timeout, and it reconnects when the service restarts.
 */
function watchCallForWaybar(): void {
  const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);
  let now: CallNow | null = null;
  const draw = () => {
    if (!now) return out({ text: "", class: "none", tooltip: "" });
    // An app's call says which app: "WhatsApp · Suhani".
    const app = now.app ? `${now.app}${now.video ? " video" : ""} · ` : now.video ? "video · " : "";
    const who = `${app}${now.contact ?? (now.number || "Unknown")}`;
    const ringing = now.state === "ringing";
    const time = callFor(Date.now() - now.since);
    // A video call's icon is a picture (the camera facing right, the bar's
    // style.css), not a glyph: no font has it facing that way.
    const icon = now.video ? "" : "\u{f03f2}  ";
    out({
      text: ringing ? `${icon}${who} · calling` : `${icon}${who} · ${time}`,
      class: [ringing ? "ringing" : "active", ...(now.video ? ["video"] : [])],
      tooltip: `${ringing ? "Incoming call from" : "On a call with"} ${who}${now.contact && now.number ? ` (${now.number})` : ""} on ${now.name}${ringing ? "" : ` · ${time}`}\nClick: open ekatva · right click: hang up`,
    });
  };
  const ws = createWSClient({
    url: `ws+unix://${socketPath()}:/`,
    WebSocket: WebSocket as never,
    retryDelayMs: () => 2000,
    onError: () => undefined,
  });
  const api = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
  api.admin.calls.watch.subscribe(undefined, {
    onData: (c) => {
      now = c;
      draw();
    },
    onError: () => {
      now = null;
      draw();
    },
  });
  draw();
  setInterval(() => now && draw(), 5000);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  // Runs for as long as waybar does: main never returns (it would exit).
  if (cmd === "call" && rest.includes("--waybar")) {
    watchCallForWaybar();
    return new Promise<void>(() => undefined);
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd === "window") {
    await openWindow(rest[0]).catch((e: Error) => fail(e.message));
    return;
  }
  if (cmd === "mcp") {
    const { serveMcp } = await import("./mcp.js");
    await serveMcp();
    return;
  }
  if (cmd === "daemon") {
    const config = loadConfig();
    const { key, where } = await loadIdentity(dirs.state(), (m) => console.error(m));
    const notify = (title: string, body: string, urgent?: boolean, open?: string) => {
      const args = ["-a", "ekatva", ...(urgent ? ["-u", "critical"] : []), title, body];
      if (!open) {
        void run("notify-send", args).catch(() => undefined);
        return;
      }
      // Clicking opens the window there; the answer itself is given in the window.
      const n = spawn("notify-send", ["-A", "default=Open", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      n.stdout.on("data", (b) => (out += String(b)));
      n.on("exit", () => {
        if (out.trim() === "default")
          void openWindow(open).catch((e: Error) => console.error(e.message));
      });
      n.on("error", () => undefined);
    };
    const d = new Daemon({
      config,
      key,
      stateDir: dirs.state(),
      configDir: dirs.config(),
      undoDir: dirs.undo(),
      socketPath: socketPath(),
      notify,
      keepTunnel: config.tunnel.mode === "always",
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
        await pair(
          api,
          flag("--grants") ?? "everything-but-root",
          // The phone and laptop are rarely on the same network: tunnel unless told not to.
          !rest.includes("--lan"),
          rest.includes("--window"),
        );
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
      case "appearance": {
        const want = rest[0];
        if (want && !["light", "dark", "toggle"].includes(want))
          fail("usage: ekatva appearance [light|dark|toggle]");
        let a = await api.appearance.get.query();
        if (want) {
          const mode = want === "toggle" ? (a.mode === "dark" ? "light" : "dark") : want;
          a = await api.appearance.set.mutate({ mode: mode as "light" | "dark" });
        }
        process.stdout.write(`${a.mode}${a.settable ? "" : ` (can't switch: ${a.why})`}
`);
        break;
      }
      case "phone": {
        const want = rest[1];
        if (rest[0] !== "appearance" || (want && !["light", "dark"].includes(want)))
          fail("usage: ekatva phone appearance [light|dark]");
        const a = (await (want
          ? api.admin.phone.mutate.mutate({
              key: null,
              path: "appearance.set",
              input: { mode: want },
            })
          : api.admin.phone.query.query({ key: null, path: "appearance.get" }))) as {
          mode: string;
          settable: boolean;
          why: string | null;
        };
        process.stdout.write(`phone: ${a.mode}${a.settable ? "" : ` (can't switch: ${a.why})`}
`);
        break;
      }
      case "jyoti": {
        // Akhaṇḍa is "on" on the wire, Nandādīpa "high"; the older names still work.
        const asked = rest[0] ? LEVEL_WORDS[rest[0].toLowerCase()] : undefined;
        if (rest[0] && !asked) fail("usage: ekatva jyoti [shanta|akhanda|nandadipa] [--for MIN]");
        const level = asked as JyotiLevel | undefined;
        const minutes = flag("--for");
        const c = level
          ? await api.jyoti.set.mutate({ level, minutes: minutes ? Number(minutes) : null })
          : await api.jyoti.get.query();
        process.stdout.write(
          `jyoti: ${LEVEL_NAME[c.level]}${c.until ? ` until ${when(c.until)}` : ""}\n`,
        );
        break;
      }
      case "call": {
        if (rest[0] === "hangup") {
          await api.admin.phone.mutate.mutate({ path: "calls.hangUp" });
          process.stdout.write("hung up\n");
          break;
        }
        // The call right now: the first thing the watch says.
        const now = await new Promise<CallNow | null>((resolve) => {
          const sub = api.admin.calls.watch.subscribe(undefined, {
            onData: (c) => {
              sub.unsubscribe();
              resolve(c);
            },
            onError: () => resolve(null),
          });
        });
        process.stdout.write(
          now
            ? `${now.state === "ringing" ? "ringing" : "on a call"}: ${now.contact ?? now.number ?? "unknown"}${now.app ? ` (${now.app})` : ""} on ${now.name} · ${callFor(Date.now() - now.since)}\n`
            : "no call\n",
        );
        break;
      }
      case "status": {
        const [s, devices] = await Promise.all([
          api.status.query(),
          api.admin.devices.list.query(),
        ]);
        // An older service has no route: say nothing about the tunnel then.
        const route = await api.admin.link.route.query().catch(() => null);
        const t = route?.tunnel;
        const away = !t
          ? ""
          : t.state === "up"
            ? `from anywhere: through ${t.url}\n`
            : t.state === "starting"
              ? `from anywhere: opening the ${t.kind} tunnel${t.problem ? ` (${t.problem})` : ""}\n`
              : t.state === "missing"
                ? `from anywhere: no (${t.problem}; install it, or the phone only connects on the same network)\n`
                : t.kind === "none"
                  ? 'from anywhere: no ([tunnel] kind = "none")\n'
                  : `from anywhere: ${t.always ? "no phone paired yet" : "opened when a phone away asks"}\n`;
        const online = devices.filter((d) => d.online);
        if (rest.includes("--waybar")) {
          const text = online.length ? online.map((d) => d.name).join(", ") : "";
          process.stdout.write(
            `${JSON.stringify({ text, tooltip: `${online.length} phone(s) connected · jyoti ${LEVEL_NAME[s.jyoti]} · ${s.waiting} agent(s) waiting`, class: [online.length ? "connected" : "idle", `jyoti-${s.jyoti}`] })}\n`,
          );
        } else if (rest.includes("--json"))
          process.stdout.write(`${JSON.stringify({ ...s, devices, route })}\n`);
        else
          process.stdout.write(
            `${s.name}: jyoti ${LEVEL_NAME[s.jyoti]}, ${s.waiting} agent(s) waiting, ${online.length ? `connected: ${online.map((d) => `${d.name} (${d.via === "lan" ? "same network" : "from away"}, encrypted)`).join(", ")}` : "no phone connected"}\n${away}${s.firewall ? `warning: ${s.firewall.problem}.\n  fix: ${s.firewall.fix}\n` : ""}`,
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
    if (argv[0] !== "daemon" && argv[0] !== "mcp") process.exit(process.exitCode ?? 0);
  },
  (e) => fail((e as Error).message),
);
