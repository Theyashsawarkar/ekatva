import type { Device, Entry, PendingPair } from "@ekatva/protocol";
import { CAPABILITIES, type Capability, PRESETS, type Preset } from "@ekatva/protocol/capabilities";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { usePoll, useSub } from "./hooks";
import { HELP, useKeys } from "./keys";
import { api, lastError } from "./rpc";

type Tab = "phones" | "log" | "caffeine" | "phone";
const TABS: { id: Tab; label: string; key: string }[] = [
  { id: "phones", label: "Phones", key: "1" },
  { id: "log", label: "Log", key: "2" },
  { id: "caffeine", label: "Caffeine", key: "3" },
  { id: "phone", label: "Phone", key: "4" },
];

const ago = (ms: number | null) => {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : new Date(ms).toLocaleDateString();
};

export function App() {
  const initial = (new URLSearchParams(location.search).get("tab") as Tab | null) ?? "phones";
  const [tab, setTab] = useState<Tab>(initial);
  const [help, setHelp] = useState(false);
  const [pairing, setPairing] = useState(initial === "phones" && location.search.includes("pair"));
  const devices = useSub<Device[]>(
    (on) => api.admin.devices.watch.subscribe(undefined, { onData: on }),
    [],
  );
  const status = usePoll(() => api.status.query(), [], 5000);
  const online = (devices ?? []).filter((d) => d.online);

  useKeys(
    {
      "1": () => setTab("phones"),
      "2": () => setTab("log"),
      "3": () => setTab("caffeine"),
      "4": () => setTab("phone"),
      p: () => {
        setTab("phones");
        setPairing(true);
      },
      "?": () => setHelp((h) => !h),
      Escape: () => (help ? setHelp(false) : setPairing(false)),
      o: () => void api.caffeine.set.mutate({ level: "off" }).then(status.reload),
      i: () => void api.caffeine.set.mutate({ level: "on" }).then(status.reload),
      h: () => void api.caffeine.set.mutate({ level: "high" }).then(status.reload),
      r: () => void api.admin.phone.mutate.mutate({ path: "ring" }).catch(() => undefined),
    },
    [help, status.reload],
  );

  return (
    <div className="app">
      <header>
        <span className="brand">
          ekatva <span className="deva">एकत्व</span>
        </span>
        <nav>
          {TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              className={tab === t.id ? "on" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label} <kbd>{t.key}</kbd>
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {status.data ? (
          <span className={`cap caf-${status.data.caffeine}`}>☕ {status.data.caffeine}</span>
        ) : null}
        <span className={`cap ${online.length ? "ok" : ""}`}>
          {online.length ? `● ${online.map((d) => d.name).join(", ")}` : "○ no phone"}
        </span>
        <button type="button" className="ghost" onClick={() => setHelp(true)}>
          <kbd>?</kbd>
        </button>
      </header>
      {status.error ? (
        <div className="banner bad">
          {lastError ?? status.error}. Start it with <code>systemctl --user start ekatva</code>.
        </div>
      ) : null}
      <main>
        {tab === "phones" ? (
          <Phones devices={devices ?? []} pairing={pairing} setPairing={setPairing} />
        ) : null}
        {tab === "log" ? <Log devices={devices ?? []} /> : null}
        {tab === "caffeine" ? <Caffeine /> : null}
        {tab === "phone" ? <Phone devices={devices ?? []} /> : null}
      </main>
      {help ? (
        <div className="scrim">
          <div className="panel help">
            <div className="listhead">
              <h3>Keys</h3>
              <span className="spacer" />
              <button type="button" onClick={() => setHelp(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
            {HELP.map(([k, d]) => (
              <div key={k} className="helprow">
                <kbd>{k}</kbd>
                <span>{d}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Phones
function Phones({
  devices,
  pairing,
  setPairing,
}: {
  devices: Device[];
  pairing: boolean;
  setPairing: (b: boolean) => void;
}) {
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const d = devices[Math.min(sel, devices.length - 1)];
  useKeys(
    {
      j: () => setSel((s) => Math.min(devices.length - 1, s + 1)),
      k: () => setSel((s) => Math.max(0, s - 1)),
      g: () => setSel(0),
      G: () => setSel(devices.length - 1),
    },
    [devices.length],
  );

  const grant = async (cap: Capability, on: boolean) => {
    if (!d) return;
    setError(null);
    const grants = on ? [...new Set([...d.grants, cap])] : d.grants.filter((g) => g !== cap);
    await api.admin.devices.grant
      .mutate({ key: d.key, grants })
      .catch((e: Error) => setError(e.message));
  };

  const unpair = async () => {
    if (
      !d ||
      !confirm(
        `Unpair ${d.name}? It can't connect until you pair it again (or undo this in the log).`,
      )
    )
      return;
    await api.admin.devices.unpair.mutate({ key: d.key }).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="split">
      <section className="list">
        <div className="listhead">
          <h2>Phones</h2>
          <button type="button" className="primary" onClick={() => setPairing(true)}>
            Pair a phone <kbd>p</kbd>
          </button>
        </div>
        {!devices.length ? (
          <p className="dim">No phone yet. Pair one: it takes a QR code and four emoji.</p>
        ) : null}
        {devices.map((x, i) => (
          <button
            type="button"
            key={x.key}
            className={`row ${i === sel ? "sel" : ""}`}
            onClick={() => setSel(i)}
          >
            <span className={`dot ${x.online ? "ok" : ""}`} />
            <span className="grow">
              <b>{x.name}</b>
              <small>
                {x.online
                  ? `connected · ${x.via === "lan" ? "near" : "away"}`
                  : `last seen ${ago(x.lastSeen)}`}
              </small>
            </span>
            <small className="dim">{x.grants.length} allowed</small>
          </button>
        ))}
      </section>
      <section className="detail">
        {pairing ? <Pair onClose={() => setPairing(false)} /> : null}
        {!pairing && d ? (
          <>
            <h2>{d.name}</h2>
            <p className="dim mono">
              key {d.key.slice(0, 4)} {d.key.slice(4, 8)} {d.key.slice(8, 12)} · paired{" "}
              {new Date(d.pairedAt).toLocaleDateString()} · {d.info.model ?? ""} {d.info.os ?? ""}
            </p>
            {error ? <div className="banner bad">{error}</div> : null}
            <h3>What it may do on this laptop</h3>
            <Grants
              caps={(Object.keys(CAPABILITIES) as Capability[]).filter(
                (c) => CAPABILITIES[c].side === "laptop" && c !== "admin",
              )}
              grants={d.grants}
              onChange={grant}
            />
            <h3>Its own events it may send here</h3>
            <Grants caps={["phone.notifications"]} grants={d.grants} onChange={grant} />
            <p className="dim small">
              What this laptop may do on the phone is decided on the phone, in its Settings.
            </p>
            <div className="actions">
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() =>
                    void api.admin.devices.grant.mutate({ key: d.key, grants: [...PRESETS[p]] })
                  }
                >
                  {p.replaceAll("-", " ")}
                </button>
              ))}
              <span className="spacer" />
              <button type="button" className="danger" onClick={() => void unpair()}>
                Unpair
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function Grants({
  caps,
  grants,
  onChange,
}: {
  caps: Capability[];
  grants: string[];
  onChange: (c: Capability, on: boolean) => void;
}) {
  return (
    <div className="grants">
      {caps.map((c) => (
        <label key={c} className={`grant risk-${CAPABILITIES[c].risk}`}>
          <input
            type="checkbox"
            checked={grants.includes(c)}
            onChange={(e) => onChange(c, e.target.checked)}
          />
          <span>
            <b>{CAPABILITIES[c].title}</b>
            <small>{CAPABILITIES[c].detail}</small>
          </span>
          <em>{CAPABILITIES[c].risk}</em>
        </label>
      ))}
    </div>
  );
}

function Pair({ onClose }: { onClose: () => void }) {
  const [offer, setOffer] = useState<{ uri: string; expires: number; lan: string[] } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("everything-but-root");
  const pending = useSub<PendingPair[]>(
    (on) => api.admin.pair.pending.subscribe(undefined, { onData: on }),
    [],
  );
  const req = pending?.[0];

  const fresh = () => {
    setError(null);
    api.admin.pair.start.mutate({ away: false }).then(
      async (o) => {
        setOffer(o);
        setQr(
          await QRCode.toDataURL(o.uri, {
            margin: 1,
            width: 280,
            color: { dark: "#111019", light: "#ffffff" },
          }),
        );
      },
      (e: Error) => setError(e.message),
    );
  };
  useEffect(fresh, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const decide = (accept: boolean) => {
    if (!req) return;
    void api.admin.pair.confirm.mutate({ id: req.id, accept, grants: [...PRESETS[preset]] }).then(
      () => (accept ? onClose() : fresh()),
      (e: Error) => setError(e.message),
    );
  };
  useKeys({ Enter: () => decide(true), x: () => decide(false) }, [req?.id, preset]);

  const left = offer ? Math.max(0, Math.round((offer.expires - now) / 1000)) : 0;
  return (
    <div className="pair">
      <div className="listhead">
        <h2>Pair a phone</h2>
        <button type="button" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      {req ? (
        <div className="request">
          <p>
            <b>{req.name}</b> wants to pair{req.info.address ? ` (from ${req.info.address})` : ""}.
            Does it show exactly these?
          </p>
          <div className="emoji">{req.sas.join(" ")}</div>
          <label className="preset">
            It may do:{" "}
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <option key={p} value={p}>
                  {p.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="button" className="primary" onClick={() => decide(true)}>
              They match: pair <kbd>Enter</kbd>
            </button>
            <button type="button" className="danger" onClick={() => decide(false)}>
              Refuse <kbd>x</kbd>
            </button>
          </div>
          <p className="dim small">If they differ, refuse: someone else may have used the code.</p>
        </div>
      ) : (
        <div className="qrbox">
          {qr ? <img src={qr} alt="Pairing code" /> : <div className="qrph" />}
          <div>
            <p>Scan this with the ekatva app.</p>
            <p className="dim">
              {left > 0
                ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.`
                : "Expired."}
            </p>
            <p className="dim small mono">{offer?.lan.join(", ") || "no network address"}</p>
            {left === 0 ? (
              <button type="button" className="primary" onClick={fresh}>
                New code
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- Log
function Log({ devices }: { devices: Device[] }) {
  const [host, setHost] = useState("self");
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const log = usePoll(
    async () => (await api.admin.log.list.query({ host, after: 0, limit: 1000 })) as Entry[],
    [host],
    3000,
  );
  const checks = usePoll(() => api.admin.log.check.query(), [], 15_000);
  const entries = useMemo(() => [...(log.data ?? [])].reverse(), [log.data]);
  const undone = new Set(entries.filter((e) => e.undoes && e.ok).map((e) => e.undoes));
  const chosen = entries[sel];
  const check = checks.data?.find((c) => c.host === host);

  const undo = (e: Entry | undefined) => {
    if (!e?.undo || !e.ok || undone.has(e.seq) || host !== "self") return;
    if (!confirm(`Undo #${e.seq}: ${e.summary}?`)) return;
    void api.journal.undo.mutate({ seq: e.seq }).then(
      (r) => {
        setNote(r.summary);
        log.reload();
      },
      (err: Error) => setNote(err.message),
    );
  };
  useKeys(
    {
      j: () => setSel((s) => Math.min(entries.length - 1, s + 1)),
      k: () => setSel((s) => Math.max(0, s - 1)),
      g: () => setSel(0),
      G: () => setSel(entries.length - 1),
      u: () => undo(chosen),
    },
    [entries.length, chosen?.seq, host],
  );

  return (
    <section className="full">
      <div className="listhead">
        <h2>Action log</h2>
        <div className="seg">
          <button
            type="button"
            className={host === "self" ? "on" : ""}
            onClick={() => setHost("self")}
          >
            This laptop
          </button>
          {devices.map((d) => (
            <button
              type="button"
              key={d.key}
              className={host === d.key ? "on" : ""}
              onClick={() => setHost(d.key)}
            >
              {d.name}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {check ? (
          <span className={`cap ${check.problem ? "bad" : "ok"}`}>
            {check.problem ? `✗ ${check.problem}` : `✓ ${check.seq} entries, intact`}
          </span>
        ) : null}
      </div>
      {note ? <div className="banner">{note}</div> : null}
      {host !== "self" ? (
        <p className="dim small">
          The copy of {devices.find((d) => d.key === host)?.name}'s log kept here. Undo its entries
          on the phone.
        </p>
      ) : null}
      <div className="log">
        {entries.map((e, i) => (
          <div key={e.seq} className={`entry ${i === sel ? "sel" : ""} ${e.ok ? "" : "failed"}`}>
            <button type="button" className="pick" onClick={() => setSel(i)}>
              <span className="mono dim">#{e.seq}</span>
              <span className="mono dim">
                {new Date(e.at).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="who">{e.actor.name}</span>
              <span className="grow">{e.summary}</span>
              {e.undoes ? <em className="tag accent">undid #{e.undoes}</em> : null}
              {!e.ok ? (
                <em className="tag bad">{e.error === "not granted" ? "refused" : "failed"}</em>
              ) : null}
              {undone.has(e.seq) ? <em className="tag">undone</em> : null}
            </button>
            {e.ok && e.undo && !undone.has(e.seq) && host === "self" ? (
              <button type="button" className="undo" onClick={() => undo(e)}>
                undo <kbd>u</kbd>
              </button>
            ) : null}
          </div>
        ))}
        {!entries.length ? <p className="dim">Nothing yet.</p> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Caffeine
function Caffeine() {
  const caf = useSub<{ level: "off" | "on" | "high"; until: number | null; lidHold: boolean }>(
    (on) => api.caffeine.watch.subscribe(undefined, { onData: on }),
    [],
  );
  const [minutes, setMinutes] = useState<number | null>(null);
  const set = (level: "off" | "on" | "high") =>
    void api.caffeine.set.mutate({ level, minutes: level === "off" ? null : minutes });
  const LEVELS = [
    { level: "off", title: "Off", detail: "Dims, locks and sleeps as usual.", key: "o" },
    {
      level: "on",
      title: "Caffeine",
      detail: "No dimming, no lock, no sleep while you're away.",
      key: "i",
    },
    {
      level: "high",
      title: "High caffeine",
      detail:
        "Keeps running with the lid closed. Closing the lid still locks it; it gives up at 10% battery.",
      key: "h",
    },
  ] as const;
  return (
    <section className="full narrow">
      <h2>Caffeine</h2>
      <div className="levels">
        {LEVELS.map((l) => (
          <button
            type="button"
            key={l.level}
            className={`level ${caf?.level === l.level ? `on lv-${l.level}` : ""}`}
            onClick={() => set(l.level)}
          >
            <b>
              {l.title} <kbd>{l.key}</kbd>
            </b>
            <small>{l.detail}</small>
          </button>
        ))}
      </div>
      <div className="seg">
        {[null, 30, 60, 120, 480].map((m) => (
          <button
            type="button"
            key={String(m)}
            className={minutes === m ? "on" : ""}
            onClick={() => setMinutes(m)}
          >
            {m === null ? "until I turn it off" : m < 60 ? `${m} min` : `${m / 60} h`}
          </button>
        ))}
      </div>
      {caf?.until ? (
        <p className="dim">
          Turns itself off at{" "}
          {new Date(caf.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
        </p>
      ) : null}
      {caf && !caf.lidHold ? (
        <p className="dim small">No lid found: high caffeine works like caffeine here.</p>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------- Phone
function Phone({ devices }: { devices: Device[] }) {
  const online = devices.find((d) => d.online);
  const status = usePoll(
    () =>
      online
        ? (api.admin.phone.query.query({ key: online.key, path: "status" }) as Promise<{
            battery: { percent: number; charging: boolean } | null;
            signal: { network: string } | null;
            awake: boolean;
          }>)
        : Promise.resolve(null),
    [online?.key],
    6000,
  );
  const [path, setPath] = useState("~");
  const files = usePoll(
    () =>
      online
        ? (api.admin.phone.query.query({
            key: online.key,
            path: "files.list",
            input: { path },
          }) as Promise<{ name: string; path: string; kind: string; size: number }[]>)
        : Promise.resolve(null),
    [online?.key, path],
    20_000,
  );
  const [note, setNote] = useState<string | null>(null);
  const [clip, setClip] = useState("");
  const ask = (p: string, input?: unknown) =>
    void api.admin.phone.mutate.mutate({ key: online?.key ?? null, path: p, input }).then(
      () => {
        setNote(`Done: ${p}`);
        status.reload();
      },
      (e: Error) => setNote(e.message),
    );

  if (!online)
    return (
      <p className="dim pad">No phone is connected. Open ekatva on the phone, on the same Wi-Fi.</p>
    );
  return (
    <div className="split">
      <section className="list">
        <h2>{online.name}</h2>
        {status.error ? <div className="banner bad">{status.error}</div> : null}
        {status.data ? (
          <p className="dim">
            {status.data.battery
              ? `${status.data.battery.percent}%${status.data.battery.charging ? " charging" : ""}`
              : "battery unknown"}{" "}
            · {status.data.signal?.network ?? "offline"} · screen{" "}
            {status.data.awake ? "kept on" : "normal"}
          </p>
        ) : null}
        <div className="actions col">
          <button type="button" onClick={() => ask("ring")}>
            Ring it <kbd>r</kbd>
          </button>
          <button type="button" onClick={() => ask("lock")}>
            Lock it
          </button>
          <button type="button" onClick={() => ask("keepAwake", { on: !status.data?.awake })}>
            {status.data?.awake ? "Let its screen sleep" : "Keep its screen on"}
          </button>
        </div>
        <h3>Clipboard</h3>
        <textarea
          value={clip}
          onChange={(e) => setClip(e.target.value)}
          placeholder="Text to put on the phone's clipboard"
          rows={3}
        />
        <button type="button" disabled={!clip} onClick={() => ask("clipboard.set", { text: clip })}>
          Send to the phone
        </button>
        {note ? <div className="banner">{note}</div> : null}
      </section>
      <section className="detail">
        <div className="listhead">
          <h3>Its files</h3>
          <span className="mono dim">{path}</span>
          {path !== "~" ? (
            <button
              type="button"
              onClick={() => setPath(path.split("/").slice(0, -1).join("/") || "~")}
            >
              Up
            </button>
          ) : null}
        </div>
        {files.error ? <div className="banner bad">{files.error}</div> : null}
        {(files.data ?? []).map((f) => (
          <button
            type="button"
            key={f.path}
            className="row"
            onClick={() => f.kind === "dir" && setPath(f.path)}
          >
            <span>{f.kind === "dir" ? "📁" : "📄"}</span>
            <span className="grow">{f.name}</span>
            <small className="dim">
              {f.kind === "dir" ? "" : `${(f.size / 1024).toFixed(1)} kB`}
            </small>
          </button>
        ))}
      </section>
    </div>
  );
}
