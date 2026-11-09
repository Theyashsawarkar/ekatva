/**
 * The keys at run time: one window listener feeding the Keymap (keymap.ts),
 * the binds each component registers (useBinds), and what they draw: the
 * mode pill, the which-key strip, the `?` sheet, the palette and the y-only
 * confirm.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type Bind,
  describe,
  fieldTakes,
  GROUPS,
  KEYS,
  Keymap,
  merge,
  movedHint,
  type Run,
  type Scope,
  token,
} from "./keymap";

// Which scope a layer is: the view's keys win the window's, a panel's win both.
const LEVEL: Record<Scope, number> = {
  window: 0,
  phones: 1,
  log: 1,
  phone: 1,
  caffeine: 1,
  pairing: 2,
};

type Overlay =
  | { kind: "help" }
  | { kind: "palette" }
  | { kind: "confirm"; question: string; done: (yes: boolean) => void }
  | null;

const layers = new Map<symbol, { scope: Scope; readonly binds: Bind[] }>();
let insert = false;
let which: string | null = null;
let hint: string | null = null;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let overlay: Overlay = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  for (const l of listeners) l();
};

const active = (): Bind[] =>
  merge([...layers.values()].sort((a, b) => LEVEL[b.scope] - LEVEL[a.scope]).map((l) => l.binds));
const keymap = new Keymap(active);
let whichTimer: ReturnType<typeof setTimeout> | undefined;

/** A text field: typing goes in it (insert mode). A checkbox or a button is not one. */
const isText = (el: Element | null, key: string): boolean =>
  !!el &&
  fieldTakes(
    {
      tagName: el.tagName,
      type: (el as HTMLInputElement).type,
      editable: (el as HTMLElement).isContentEditable,
    },
    key,
  );

/** Ask with a y-only answer: y says yes, any other key no. */
export function confirmKey(question: string): Promise<boolean> {
  return new Promise((done) => {
    overlay = { kind: "confirm", question, done };
    changed();
  });
}

export const openHelp = () => {
  overlay = overlay?.kind === "help" ? null : { kind: "help" };
  changed();
};
export const openPalette = () => {
  overlay = { kind: "palette" };
  changed();
};
const closeOverlay = () => {
  overlay = null;
  changed();
};

function onKey(e: KeyboardEvent) {
  const t = token(e);
  if (overlay?.kind === "confirm") {
    if (t === null) return;
    e.preventDefault();
    const { done } = overlay;
    overlay = null;
    changed();
    done(e.key === "y");
    return;
  }
  if (isText(e.target as Element | null, e.key)) {
    // Insert mode: the field gets every key; Esc goes back to normal mode.
    if (e.key === "Escape" && overlay?.kind !== "palette") {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
    return;
  }
  if (t === null) return;
  if (overlay?.kind === "help") {
    if (t === "Esc" || t === "?" || t === "q") {
      e.preventDefault();
      closeOverlay();
    }
    return;
  }
  const r = keymap.feed(t);
  clearTimeout(whichTimer);
  if (r.kind === "pending") {
    which = null;
    whichTimer = setTimeout(() => {
      which = keymap.prefix || null;
      changed();
    }, 300);
  } else which = null;
  clearTimeout(hintTimer);
  hint = r.kind === "none" ? movedHint(t) : null;
  if (hint)
    hintTimer = setTimeout(() => {
      hint = null;
      changed();
    }, 3000);
  if (r.kind !== "none") e.preventDefault();
  changed();
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKey);
  const mode = () => {
    const now = isText(document.activeElement, "");
    if (now !== insert) {
      insert = now;
      changed();
    }
  };
  window.addEventListener("focusin", mode);
  window.addEventListener("focusout", () => setTimeout(mode, 0));
}

/**
 * Binds `map`'s keys for as long as the component is on screen (always the
 * latest render's actions). Descriptions come from KEYS.
 */
export function useBinds(scope: Scope, map: Record<string, Run | undefined>): void {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    install();
    const layer = {
      scope,
      get binds(): Bind[] {
        return Object.entries(latest.current)
          .filter((e): e is [string, Run] => e[1] !== undefined)
          .map(([keys, run]) => ({ keys, run, desc: describe(scope, keys) }));
      },
    };
    const id = Symbol(scope);
    layers.set(id, layer);
    changed();
    return () => {
      layers.delete(id);
      changed();
    };
  }, [scope]);
}

function useKeysState() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return { insert, which, hint, overlay, pending: keymap.prefix, count: keymap.count };
}

/** NORMAL / INSERT, and what's pending (a count, `g`, `Space c`). */
export function ModePill() {
  const s = useKeysState();
  return (
    <span className={`mode ${s.insert ? "insert" : "normal"}`}>
      {s.insert ? "INSERT" : "NORMAL"}
      {s.count || s.pending ? (
        <span className="pending">
          {s.count}
          {s.pending ? ` ${s.pending}` : ""}
        </span>
      ) : null}
    </span>
  );
}

/** The which-key strip, the `?` sheet, the palette and the confirm. */
export function KeyLayer() {
  const s = useKeysState();
  if (s.overlay?.kind === "confirm")
    return (
      <div className="scrim">
        <div className="panel confirm">
          <p>{s.overlay.question}</p>
          <p className="dim small">
            <kbd>y</kbd> yes · any other key no
          </p>
        </div>
      </div>
    );
  if (s.overlay?.kind === "help") return <Help />;
  if (s.overlay?.kind === "palette") return <Palette />;
  if (!s.which)
    return s.hint ? (
      <div className="which">
        <span className="dim">{s.hint}</span>
      </div>
    ) : null;
  const next = keymap.next(s.which);
  return (
    <div className="which">
      <div className="whichhead">
        <kbd>{s.which}</kbd> <span className="dim">{GROUPS[s.which] ?? ""}</span>
        <span className="spacer" />
        <span className="dim small">
          <kbd>Esc</kbd> cancel
        </span>
      </div>
      <div className="whichgrid">
        {next.map(([k, d]) => (
          <span key={k} className="whichitem">
            <kbd>{k}</kbd> {d}
          </span>
        ))}
      </div>
    </div>
  );
}

function Help() {
  const binds = active();
  const scopes = [...new Set([...layers.values()].map((l) => l.scope))];
  const rows = KEYS.filter((k) => scopes.includes(k.scope) && binds.some((b) => b.keys === k.keys));
  return (
    <div className="scrim">
      <div className="panel help">
        <div className="listhead">
          <h3>Keys</h3>
          <span className="spacer" />
          <button type="button" onClick={closeOverlay}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <p className="dim small">
          <kbd>Space</kbd> is the leader: after it the strip shows what can follow. <kbd>i</kbd> or
          a click types in a field, <kbd>Esc</kbd> leaves it.
        </p>
        <div className="helpcols">
          {rows.map((k) => (
            <div key={`${k.scope}${k.keys}`} className="helprow">
              <kbd>{k.keys}</kbd>
              <span>{k.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Palette() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const binds = active().filter((b) => b.keys !== "Space Space");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = binds.filter((b) =>
    words.every((w) => `${b.desc} ${b.keys}`.toLowerCase().includes(w)),
  );
  const run = (b: Bind | undefined) => {
    closeOverlay();
    b?.run(1);
  };
  return (
    <div className="scrim">
      <div className="panel palette">
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette is for typing
          autoFocus
          value={q}
          placeholder="What do you want to do?"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeOverlay();
            else if (e.key === "Enter") run(hits[sel]);
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j"))
              setSel((s) => Math.min(hits.length - 1, s + 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k"))
              setSel((s) => Math.max(0, s - 1));
            else return;
            e.preventDefault();
          }}
        />
        <div className="palettelist">
          {hits.map((b, i) => (
            <button
              type="button"
              key={b.keys}
              className={`row ${i === sel ? "sel" : ""}`}
              onClick={() => run(b)}
            >
              <span className="grow">{b.desc}</span>
              <kbd>{b.keys}</kbd>
            </button>
          ))}
          {!hits.length ? <p className="dim">Nothing matches.</p> : null}
        </div>
      </div>
    </div>
  );
}
