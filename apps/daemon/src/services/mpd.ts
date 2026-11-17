/**
 * A tiny MPD client, just enough to tell the phone which songs sit either
 * side of the one playing (nāda plays through MPD): the text protocol over
 * MPD's socket ($MPD_HOST, else $XDG_RUNTIME_DIR/mpd/socket, else
 * localhost:6600), as nāda's own client does.
 */
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

export interface Song {
  title: string;
  artist: string;
}

export interface Queue {
  prev: Song | null;
  next: Song | null;
}

/** Where MPD listens: a socket path, or a host and port. */
export function mpdAddress(
  env: NodeJS.ProcessEnv = process.env,
): { path: string } | { host: string; port: number } {
  const host = env.MPD_HOST ?? "";
  if (host.startsWith("/") && existsSync(host)) return { path: host };
  if (host && !host.startsWith("/")) return { host, port: Number(env.MPD_PORT) || 6600 };
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && existsSync(join(runtime, "mpd", "socket")))
    return { path: join(runtime, "mpd", "socket") };
  return { host: "localhost", port: Number(env.MPD_PORT) || 6600 };
}

/** Sends commands one after another and returns each one's key/value pairs. */
function ask(
  where: { path: string } | { host: string; port: number },
  commands: string[],
  timeoutMs: number,
): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createConnection(where as never);
    const answers: Record<string, string>[] = [];
    let buf = "";
    let greeted = false;
    let current: Record<string, string> = {};
    const done = (e?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      e ? reject(e) : resolve(answers);
    };
    const timer = setTimeout(() => done(new Error("MPD didn't answer")), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("error", (e) => done(e));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!greeted) {
          if (!line.startsWith("OK MPD")) return done(new Error("not MPD"));
          greeted = true;
          sock.write(`${commands.join("\n")}\n`);
          continue;
        }
        if (line === "OK") {
          answers.push(current);
          current = {};
          if (answers.length === commands.length) return done();
        } else if (line.startsWith("ACK")) {
          answers.push({});
          current = {};
          if (answers.length === commands.length) return done();
        } else {
          const i = line.indexOf(": ");
          // The first of each key (playlistinfo of one song has one of each).
          if (i > 0 && !(line.slice(0, i) in current))
            current[line.slice(0, i)] = line.slice(i + 2);
        }
      }
    });
  });
}

const song = (r: Record<string, string> | undefined): Song | null =>
  r?.file
    ? {
        title: r.Title || (r.file.split("/").pop() ?? r.file).replace(/\.[^.]+$/, ""),
        artist: r.Artist ?? r.AlbumArtist ?? "",
      }
    : null;

/** The songs before and after the current one in MPD's queue (wrapping when it repeats). */
export async function mpdQueue(where = mpdAddress(), timeoutMs = 600): Promise<Queue | null> {
  const [status] = await ask(where, ["status"], timeoutMs);
  const pos = Number(status?.song);
  const length = Number(status?.playlistlength);
  if (!status || !Number.isInteger(pos) || !length) return null;
  const repeat = status.repeat === "1";
  const at = (n: number) => (repeat ? (n + length) % length : n);
  const prevAt = at(pos - 1);
  const nextAt = at(pos + 1);
  const want = [prevAt, nextAt].filter((n) => n >= 0 && n < length && n !== pos);
  if (!want.length) return { prev: null, next: null };
  const info = await ask(
    where,
    want.map((n) => `playlistinfo ${n}`),
    timeoutMs,
  );
  const byPos = new Map(want.map((n, i) => [n, song(info[i])]));
  return {
    prev: prevAt !== pos ? (byPos.get(prevAt) ?? null) : null,
    next: nextAt !== pos ? (byPos.get(nextAt) ?? null) : null,
  };
}
