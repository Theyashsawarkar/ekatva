import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Bind,
  fieldTakes,
  GROUPS,
  KEYS,
  Keymap,
  MOVED,
  merge,
  movedHint,
  token,
} from "../src/renderer/src/keymap";

const make = (keys: string[]) => {
  const ran: [string, number][] = [];
  const binds: Bind[] = keys.map((k) => ({ keys: k, desc: k, run: (n) => ran.push([k, n]) }));
  return { km: new Keymap(() => binds), ran };
};

describe("keymap", () => {
  it("runs single keys and repeats them with a count", () => {
    const { km, ran } = make(["j", "1"]);
    km.feed("j");
    km.feed("5");
    km.feed("j");
    expect(ran).toEqual([
      ["j", 1],
      ["j", 5],
    ]);
  });

  it("lets a digit bound on its own win over a count", () => {
    const { km, ran } = make(["1", "j"]);
    expect(km.feed("1").kind).toBe("ran");
    expect(ran).toEqual([["1", 1]]);
  });

  it("waits on a prefix, runs the sequence, and lists what can follow", () => {
    const { km, ran } = make(["Space c o", "Space c i", "Space p r", "g g"]);
    expect(km.feed("Space")).toEqual({ kind: "pending", prefix: "Space" });
    expect(km.next("Space").map(([k]) => k)).toEqual(["c", "p"]);
    expect(km.feed("c").kind).toBe("pending");
    expect(km.next("Space c")).toEqual([
      ["o", "Space c o"],
      ["i", "Space c i"],
    ]);
    km.feed("o");
    km.feed("g");
    km.feed("g");
    expect(ran.map(([k]) => k)).toEqual(["Space c o", "g g"]);
    expect(km.prefix).toBe("");
  });

  it("cancels a pending key with Esc or an unknown key", () => {
    const { km, ran } = make(["Space d d", "Esc"]);
    km.feed("Space");
    expect(km.feed("Esc").kind).toBe("cancelled");
    km.feed("Space");
    expect(km.feed("x").kind).toBe("cancelled");
    expect(ran).toEqual([]);
    expect(km.feed("Esc").kind).toBe("ran");
  });

  it("lets the most specific layer win a key", () => {
    const a: Bind = { keys: "r", desc: "log", run: () => {} };
    const b: Bind = { keys: "r", desc: "window", run: () => {} };
    expect(merge([[a], [b]])).toEqual([a]);
  });

  it("names keys like the annotations do", () => {
    const k = { ctrlKey: false, altKey: false, metaKey: false };
    expect(token({ ...k, key: " " })).toBe("Space");
    expect(token({ ...k, key: "Escape" })).toBe("Esc");
    expect(token({ ...k, key: "G" })).toBe("G");
    expect(token({ ...k, key: "j", ctrlKey: true })).toBeNull();
  });
});

describe("the key list", () => {
  // `Space t p / t l` is `Space t p` and `Space t l`; `j / k` is `j` and `k`.
  const annotated = new Set<string>();
  const src = readFileSync(new URL("../src/renderer/src/keymap.ts", import.meta.url), "utf8");
  for (const m of src.matchAll(/# keybind: Ekatva\/\w+ \| ([^|]+) \|/g)) {
    const alts = (m[1] ?? "").trim().split(" / ");
    const first = (alts[0] ?? "").split(" ");
    for (const a of alts) {
      const parts = a.split(" ");
      const inherit = first[0] === "Space" ? first.slice(0, first.length - parts.length) : [];
      annotated.add([...inherit, ...parts].join(" "));
    }
  }

  it("annotates every key for the keybinding search", () => {
    const missing = [...new Set(KEYS.map((k) => k.keys))].filter((k) => !annotated.has(k));
    expect(missing).toEqual([]);
  });

  it("annotates no key that doesn't exist", () => {
    const known = new Set(KEYS.map((k) => k.keys));
    expect([...annotated].filter((k) => !known.has(k) && k !== "Space")).toEqual([]);
  });

  it("uses Space's groups the way every Vayu tool does", () => {
    // reserved letters keep their meaning; c (caffeine) and p (the phone) are this tool's nouns
    const meaning: Record<string, string> = {
      t: "tabs",
      y: "copy / send",
      d: "delete",
      a: "add",
      m: "mark",
    };
    const allowed = new Set([...Object.keys(meaning), "c", "p", "q", "?", "Space"]);
    for (const k of KEYS.filter((k) => k.keys.startsWith("Space "))) {
      const g = k.keys.split(" ")[1] ?? "";
      expect(allowed.has(g), k.keys).toBe(true);
      if (meaning[g]) expect(GROUPS[`Space ${g}`]).toBe(meaning[g]);
    }
  });
});

describe("moved keys", () => {
  it("says where a moved key went when nothing binds it", () => {
    const { km } = make(["Space a p", "j"]);
    expect(km.feed("p").kind).toBe("none");
    expect(movedHint("p")).toBe("p moved: pairing a phone is Space a p now");
    expect(movedHint("j")).toBeNull();
  });

  it("points only at keys that exist, and no window key shadows a hint", () => {
    const known = new Set(KEYS.map((k) => k.keys));
    const windowKeys = new Set(KEYS.filter((k) => k.scope === "window").map((k) => k.keys));
    for (const [old, [now]] of Object.entries(MOVED)) {
      expect(known.has(now), now).toBe(true);
      expect(windowKeys.has(old), old).toBe(false);
    }
  });
});

describe("fieldTakes", () => {
  it("gives text boxes every key, but not checkboxes or buttons", () => {
    expect(fieldTakes({ tagName: "INPUT", type: "text" }, "j")).toBe(true);
    expect(fieldTakes({ tagName: "TEXTAREA" }, "Enter")).toBe(true);
    expect(fieldTakes({ tagName: "DIV", editable: true }, "j")).toBe(true);
    expect(fieldTakes({ tagName: "INPUT", type: "checkbox" }, "j")).toBe(false);
    expect(fieldTakes({ tagName: "BUTTON" }, "j")).toBe(false);
  });
  it("leaves Enter in a drop-down to the window (pairing's Enter pairs)", () => {
    expect(fieldTakes({ tagName: "SELECT" }, "Enter")).toBe(false);
    expect(fieldTakes({ tagName: "SELECT" }, "ArrowDown")).toBe(true);
    expect(fieldTakes({ tagName: "SELECT" }, "j")).toBe(true);
  });
});
