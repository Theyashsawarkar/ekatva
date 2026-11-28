/** The real phone behind the core's interfaces: Expo's modules on Android. */

import { BEACON_PORT, BEACON_SIZE, fromB64u, Ntfy, webSocketTransport } from "@ekatva/link";
import { CHUNK, PIECE } from "@ekatva/protocol";
import * as Battery from "expo-battery";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { AppState, Linking, Vibration } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import { toB64 } from "../core/b64";

/** The native module, when this build has it (a local const narrows in closures). */
const native = phone;

import type { NativeApps } from "../core/apps";
import { clip } from "../core/clip";
import type { Fs, FsStat } from "../core/files";
import type { KV } from "../core/kv";
import type { Opener } from "../core/link";
import type { Lines } from "../core/logStore";
import type { DeviceApi } from "../core/services";
import type { Platform } from "../core/session";
import type { ShareHost } from "../core/share";
import type { SecretBox } from "../core/vault";

const VAULT = "ekatva.vault";

/** SecureStore (Android keystore); the vault itself also needs the fingerprint. */
const kv: KV = {
  get: (k) =>
    SecureStore.getItemAsync(
      k.replace(/[^\w.-]/g, "_"),
      k === VAULT ? { requireAuthentication: true, authenticationPrompt: "Unlock ekatva" } : {},
    ),
  set: (k, v) =>
    SecureStore.setItemAsync(
      k.replace(/[^\w.-]/g, "_"),
      v,
      k === VAULT
        ? {
            requireAuthentication: true,
            authenticationPrompt: "Protect ekatva with your fingerprint",
          }
        : {},
    ),
  remove: (k) => SecureStore.deleteItemAsync(k.replace(/[^\w.-]/g, "_")),
};

function lines(name: string): Lines {
  const dir = new Directory(Paths.document, "logs");
  const file = new File(dir, `${name.replace(/[^\w-]/g, "_")}.log`);
  return {
    async read() {
      if (!file.exists) return [];
      return (await file.text()).split("\n");
    },
    async append(line) {
      if (!dir.exists) dir.create({ intermediates: true });
      if (!file.exists) file.create();
      file.write(`${line}\n`, { append: true });
    },
    async remove() {
      if (file.exists) file.delete();
    },
    // The last `n` lines only, read backwards from the end (the log is ASCII:
    // base64url lines), so unlocking never reads the whole history.
    async tail(n) {
      if (!file.exists) return [];
      const h = file.open();
      try {
        let pos = h.size ?? 0;
        let text = "";
        let newlines = 0;
        while (pos > 0 && newlines <= n) {
          const len = Math.min(64 * 1024, pos);
          pos -= len;
          h.offset = pos;
          const bytes = await h.readBytes(len);
          let chunk = "";
          for (let i = 0; i < bytes.length; i += 8192)
            chunk += String.fromCharCode(...bytes.subarray(i, i + 8192));
          for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) newlines++;
          text = chunk + text;
        }
        const lines = text.split("\n");
        // Started mid-line: the first piece isn't a whole line.
        if (pos > 0) lines.shift();
        return lines.filter(Boolean).slice(-n);
      } finally {
        h.close();
      }
    },
  };
}

const uri = (p: string) => `file://${p}`;
const node = (p: string): File | Directory | null => {
  const d = new Directory(uri(p));
  if (d.exists) return d;
  const f = new File(uri(p));
  return f.exists ? f : null;
};

const fs: Fs = {
  async list(dir) {
    return new Directory(uri(dir)).list().map((e) => e.name);
  },
  ...(native ? { listDetailed: (dir: string) => native.listDir(dir) } : {}),
  async stat(p): Promise<FsStat | null> {
    const n = node(p);
    if (!n) return null;
    if (n instanceof Directory) return { isDir: true, size: 0, mtime: 0 };
    return { isDir: false, size: n.size ?? 0, mtime: n.modificationTime ?? 0 };
  },
  async read(p, offset, length) {
    const h = new File(uri(p)).open();
    try {
      h.offset = offset;
      // At most a piece per call; the caller reads on until the end.
      return toB64(await h.readBytes(Math.min(length, CHUNK)));
    } finally {
      h.close();
    }
  },
  async write(p, data) {
    const f = new File(uri(p));
    if (!f.exists) f.create({ intermediates: true });
    f.write(data, { encoding: "base64" });
  },
  async append(p, data) {
    new File(uri(p)).write(data, { encoding: "base64", append: true });
  },
  async truncate(p, size) {
    // Copies the part kept, a piece at a time, then swaps it in: never the
    // whole file in memory (the file handle can't truncate).
    const f = new File(uri(p));
    const tmp = new File(`${uri(p)}.ekatva-truncate`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    const from = f.open();
    const to = tmp.open();
    try {
      for (let left = size; left > 0; ) {
        const bytes = await from.readBytes(Math.min(left, PIECE));
        if (!bytes.length) break;
        await to.writeBytes(bytes);
        left -= bytes.length;
      }
    } finally {
      from.close();
      to.close();
    }
    f.delete();
    tmp.move(new File(uri(p)));
  },
  async mkdir(p) {
    const d = new Directory(uri(p));
    if (!d.exists) d.create({ intermediates: true });
  },
  async move(from, to) {
    const n = node(from);
    if (!n) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    const parent = new Directory(uri(to.replace(/\/[^/]*$/, "") || "/"));
    if (!parent.exists) parent.create({ intermediates: true });
    n.move(n instanceof Directory ? new Directory(uri(to)) : new File(uri(to)));
  },
  async copy(from, to) {
    const n = node(from);
    if (!n) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    n.copy(n instanceof Directory ? new Directory(uri(to)) : new File(uri(to)));
  },
  async remove(p) {
    node(p)?.delete();
  },
};

type Native = NonNullable<typeof phone>;
const lockOf = (n: Native) => async () => n.lock();
const callsOf = (n: Native): DeviceApi["calls"] => ({
  dial: async (num) => n.dial(num),
  answer: async () => n.answer(),
  hangUp: async () => n.hangUp(),
  log: async (limit) => n.callLog(limit),
});
const smsOf = (n: Native): DeviceApi["sms"] => ({
  threads: async () => n.smsThreads(50),
  read: async (thread, limit) => n.smsRead(thread, limit),
  send: async (to, text) => n.smsSend(to, text),
});

let awake = false;
const device: DeviceApi = {
  name: Device.deviceName ?? Device.modelName ?? "phone",
  async battery() {
    const [level, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    if (level < 0) return null;
    return {
      percent: Math.round(level * 100),
      charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    };
  },
  async signal() {
    const n = await Network.getNetworkStateAsync();
    if (!n.isConnected) return null;
    return {
      bars: 4,
      network:
        n.type === Network.NetworkStateType.WIFI
          ? "Wi-Fi"
          : n.type === Network.NetworkStateType.CELLULAR
            ? "mobile"
            : String(n.type).toLowerCase(),
    };
  },
  async locked() {
    return null;
  },
  async ring(from) {
    // Until stopped, at full volume, through silent and Do Not Disturb (Ring.kt).
    if (native) native.ring(from);
    else Vibration.vibrate([0, 600, 300, 600, 300, 600, 300, 1200]);
  },
  async stopRinging() {
    native?.stopRinging();
    Vibration.cancel();
  },
  ringing: () => native?.ringing() ?? false,
  async keepAwake(on) {
    if (on) await activateKeepAwakeAsync("ekatva");
    else deactivateKeepAwake("ekatva");
    awake = on;
  },
  awake: () => awake,
  clipboardGet: () => Clipboard.getStringAsync(),
  async clipboardSet(text) {
    // From the laptop: not news to send back to it.
    clip.heard = text;
    await Clipboard.setStringAsync(text);
  },
  lock: native ? lockOf(native) : null,
  appearance: native
    ? {
        get: async () => native.appearance(),
        set: (mode) => native.setAppearance(mode === "dark"),
      }
    : null,
  calls: native ? callsOf(native) : null,
  sms: native ? smsOf(native) : null,
  notifications: native
    ? {
        dismiss: async (id) => native.dismissNotification(id),
        act: async (id, index, reply) => native.notificationAction(id, index, reply),
        show: async (n) =>
          native.showLaptopNotification(
            n.id,
            n.app,
            n.title,
            n.text,
            n.icon ?? null,
            n.picture ?? null,
            n.urgency ?? null,
          ),
        close: async (id) => native.closeLaptopNotification(id),
      }
    : null,
};

/** The vault's box: the keystore key behind the fingerprint or the screen lock (VaultKey.kt). */
const box: SecretBox | undefined = native
  ? {
      exists: async () => native.vaultExists(),
      seal: (text) => native.vaultSeal(text, "Protect ekatva"),
      open: () => native.vaultOpen("Unlock ekatva"),
      wipe: async () => native.vaultWipe(),
    }
  : undefined;

/** The same box, for the laptop passwords Unlock keeps (core/vault.ts LaptopPasswords). */
export const vaultBox = box;

/** Where files from the laptop go: Download/ekatva when all files are allowed, else the app's folder. */
async function shareDir(): Promise<string> {
  const [root] = await roots();
  return root === "/storage/emulated/0" ? `${root}/Download/ekatva` : `${root}/From laptop`;
}

let shareNote = 0;
const shareHost: ShareHost = {
  dir: shareDir,
  async openUrl(url) {
    await Linking.openURL(url);
  },
  async setClipboard(text) {
    await Clipboard.setStringAsync(text);
  },
  notify(title, text) {
    try {
      native?.showLaptopNotification(
        `share-${shareNote++}`,
        "ekatva",
        title,
        text,
        null,
        null,
        null,
      );
    } catch {
      // notifications not allowed: the file is there all the same
    }
  },
};

const open: Opener = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("the laptop didn't answer"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(webSocketTransport(ws as never));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("can't reach the laptop"));
    });
  });

/** The laptop's beacons on this network, from the native module (none in Expo Go). */
const beacons: Platform["beacons"] = native
  ? (cb) => {
      const sub = native.addListener("onBeacon", (e) => {
        try {
          cb(e.from, fromB64u(e.data));
        } catch {
          // not base64url: not ours
        }
      });
      try {
        native.listenBeacons(BEACON_PORT, BEACON_SIZE);
      } catch (e) {
        console.info(`[ekatva link] can't listen for the laptop's beacon: ${(e as Error).message}`);
      }
      return () => {
        sub.remove();
        native.stopBeacons();
      };
    }
  : undefined;

/** Other Vayu apps on the phone, through AppBridgeService (none in Expo Go). */
const apps: NativeApps | undefined = native
  ? {
      onMessage: (cb) => {
        const sub = native.addListener("onApp", (e) => {
          if (e.kind === "bye") cb({ kind: "bye", package: e.package });
          else if (e.kind === "hello")
            cb({
              kind: "hello",
              package: e.package,
              cert: e.cert ?? "",
              status: e.status ?? "refused",
              json: e.json ?? "{}",
            });
          else cb({ kind: e.kind, package: e.package, json: e.json ?? "{}" });
        });
        // Listening now: the apps already connected say hello again.
        native.appReady();
        return () => sub.remove();
      },
      send: (pkg, what, json) => native.appSend(pkg, what, json),
      decide: async (a) => native.appDecide(a.package, a.cert, a.id, a.name, a.state === "allowed"),
      approvals: async () => native.appApprovals(),
      revoke: async (pkg) => native.appRevoke(pkg),
      notify: (id, title, text) => {
        try {
          native.showLaptopNotification(id, "ekatva", title, text, null, null, 1);
        } catch {
          // notifications not allowed: the sheet shows when ekatva opens
        }
      },
      unnotify: (id) => {
        try {
          native.closeLaptopNotification(id);
        } catch {
          // already gone
        }
      },
    }
  : undefined;

/** The answer, until the app comes back to the front (the grant may have changed meanwhile). */
let rootsCache: string[] | null = null;
AppState.addEventListener("change", (st) => {
  if (st === "active") rootsCache = null;
});

/**
 * Shared storage when "All files access" is allowed, else the app's own Shared
 * folder. Asks Android (isExternalStorageManager, through the module's status)
 * instead of listing the whole storage root to find out.
 */
async function roots(): Promise<string[]> {
  if (rootsCache) return rootsCache;
  let all = false;
  try {
    if (phone) all = phone.status().allFiles;
    else {
      // Expo Go (no module): listing it only works with the access.
      new Directory("file:///storage/emulated/0").list();
      all = true;
    }
  } catch {
    all = false;
  }
  if (all) rootsCache = ["/storage/emulated/0"];
  else {
    const own = new Directory(Paths.document, "Shared");
    if (!own.exists) own.create({ intermediates: true });
    rootsCache = [own.uri.replace(/^file:\/\//, "").replace(/\/$/, "")];
  }
  return rootsCache;
}

export function platform(onAlert: (m: string) => void): Platform {
  return {
    kv,
    lines,
    fs,
    roots,
    undoDir: new Directory(Paths.document, "undo").uri.replace(/^file:\/\//, "").replace(/\/$/, ""),
    device,
    open,
    info: {
      app: String(Constants.expoConfig?.version ?? "0"),
      os: `Android ${Device.osVersion ?? ""}`.trim(),
      model: Device.modelName ?? "",
    },
    onAlert,
    shareHost,
    ...(box ? { box } : {}),
    ntfy: new Ntfy(),
    ...(beacons ? { beacons } : {}),
    ...(apps ? { apps } : {}),
    // The native side reads and writes here too (AppBridge.FILES).
    appFilesDir: new Directory(Paths.cache, "app-files").uri
      .replace(/^file:\/\//, "")
      .replace(/\/$/, ""),
    online: async () => {
      const n = await Network.getNetworkStateAsync();
      return n.isConnected !== false;
    },
    async wipeFiles() {
      for (const name of ["logs", "undo"]) {
        const d = new Directory(Paths.document, name);
        if (d.exists) d.delete();
      }
    },
  };
}
