/** The real phone behind the core's interfaces: Expo's modules on Android. */
import { webSocketTransport } from "@ekatva/link";
import * as Battery from "expo-battery";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { Vibration } from "react-native";
import type { Fs, FsStat } from "../core/files";
import type { KV } from "../core/kv";
import type { Opener } from "../core/link";
import type { Lines } from "../core/logStore";
import type { DeviceApi } from "../core/services";
import type { Platform } from "../core/session";

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
      const bytes = await h.readBytes(length);
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
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
    const f = new File(uri(p));
    const keep = (await f.bytes()).slice(0, size);
    f.write(keep);
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
  async ring() {
    Vibration.vibrate([0, 600, 300, 600, 300, 600, 300, 1200]);
  },
  async keepAwake(on) {
    if (on) await activateKeepAwakeAsync("ekatva");
    else deactivateKeepAwake("ekatva");
    awake = on;
  },
  awake: () => awake,
  clipboardGet: () => Clipboard.getStringAsync(),
  async clipboardSet(text) {
    await Clipboard.setStringAsync(text);
  },
  lock: null,
  calls: null,
  sms: null,
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

/** Shared storage when "All files access" is allowed, else the app's own Shared folder. */
async function roots(): Promise<string[]> {
  try {
    new Directory("file:///storage/emulated/0").list();
    return ["/storage/emulated/0"];
  } catch {
    const own = new Directory(Paths.document, "Shared");
    if (!own.exists) own.create({ intermediates: true });
    return [own.uri.replace(/^file:\/\//, "").replace(/\/$/, "")];
  }
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
  };
}
