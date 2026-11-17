import type { RootRequest } from "@ekatva/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { errorText } from "../../ui/errors";
import { Icon } from "../../ui/icon";
import { Btn, Glyph, List, Sheet, Toggle, Txt } from "../../ui/lac";
import { Outcome } from "../../ui/root-outcome";
import { useApp, useLaptop, useLink, usePoll } from "../../ui/state";
import { font, k } from "../../ui/theme";

/** dvarapala's limits (dialog.py): open 10 minutes, 3 wrong passwords. */
const EXPIRES_MS = 10 * 60_000;
const ATTEMPTS = 3;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * A root request from the laptop: exactly the commands the window there
 * shows. Approving takes the laptop's password (your sudo password there),
 * not the phone's fingerprint: the window on the laptop checks it with sudo
 * and runs what's ticked. The same request is open on the laptop too; the
 * first answer, there or here, is the one that counts. Once it ends, this
 * screen shows how: what ran and each command's exit code.
 */
export default function Root() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useApp();
  const laptop = useLaptop();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const pending = usePoll(() => client?.root.pending.query() ?? null, [client], 1500);
  const r = pending.data?.find((x) => x.id === id);
  // Remember the request, to find its outcome once it's gone.
  const [seen, setSeen] = useState<RootRequest | null>(null);
  useEffect(() => {
    if (r) setSeen(r);
  }, [r]);
  const ended = pending.data !== null && !r;
  const history = usePoll(
    () => (ended ? (client?.root.history.query() ?? null) : null),
    [client, ended],
    2500,
  );
  const outcome = history.data?.find((h) => h.id === seen?.ref) ?? null;

  const [off, setOff] = useState<Set<number>>(new Set());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const answer = async (approve: boolean) => {
    if (!client || !r) return;
    setBusy(true);
    setError(null);
    const allow = r.commands.map((_, i) => i).filter((i) => !off.has(i));
    await client.root.respond
      .mutate({ id: r.id, approve, password: approve ? password : null, allow })
      .then(() => setPassword(""))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const name = laptop?.name ?? "the laptop";

  if (ended)
    return (
      <Sheet>
        {outcome ? (
          <Outcome h={outcome} />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Glyph name="spin" color={k.mute} size={42} radius={13} />
            <Txt size={15} color={k.sub} style={{ flex: 1, lineHeight: 21 }}>
              {seen
                ? "Answered. Waiting for the result from the laptop…"
                : "This request has been answered, or it expired."}
            </Txt>
          </View>
        )}
        <Btn label="Root requests" onPress={() => router.replace("/root-history")} />
      </Sheet>
    );

  if (!r)
    return (
      <Sheet>
        <Txt size={15} color={k.sub}>
          {pending.error ?? "Loading…"}
        </Txt>
      </Sheet>
    );

  const chosen = r.commands.length - off.size;
  const left = r.at + EXPIRES_MS - now;
  return (
    <Sheet>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <Glyph name="shield" color={k.rose} size={42} radius={13} />
        <View style={{ flex: 1 }}>
          <Txt
            display
            w="700"
            size={24}
            style={{ letterSpacing: -0.48, marginTop: 2, marginBottom: 4 }}
          >
            {r.requester} wants root
          </Txt>
          <Txt size={13} color={k.sub}>
            On {name}, through {r.via === "polkit" ? "pramana" : "dvarapala"}.{" "}
            <Txt size={13} color={left < 60_000 ? k.rose : k.sub}>
              {clock(left)} left.
            </Txt>
          </Txt>
        </View>
      </View>
      {r.reason ? (
        <Txt size={16} style={{ lineHeight: 24, marginBottom: 6 }}>
          “{r.reason}”
        </Txt>
      ) : null}
      <Txt size={13} color={k.sub} style={{ marginBottom: 14 }}>
        Also open on the laptop. The first answer counts.
      </Txt>

      <List inset={0}>
        {r.commands.map((cmd, i) => {
          const on = !off.has(i);
          const set = (v: boolean) => {
            const next = new Set(off);
            if (v) next.delete(i);
            else next.add(i);
            setOff(next);
          };
          return (
            <View
              key={`${cmd.cmd}\u0000${cmd.why}`}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 12,
                paddingVertical: 14,
                paddingHorizontal: 16,
              }}
            >
              <Toggle on={on} onChange={set} label={`Run: ${cmd.why || cmd.cmd}`} />
              <View style={{ flex: 1 }}>
                <Txt w="600" style={{ marginBottom: 4 }}>
                  {cmd.why || "No reason given"}
                </Txt>
                <Txt mono size={12.5} color={on ? k.rose : k.mute}>
                  {cmd.cmd}
                </Txt>
              </View>
            </View>
          );
        })}
      </List>

      <Txt size={13} color={k.sub} style={{ marginTop: 16 }}>
        {name}'s password
      </Txt>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          backgroundColor: k.ink,
          borderWidth: 1,
          borderColor: r.state === "wrong" ? `${k.rose}99` : k.line2,
          borderRadius: 14,
          paddingHorizontal: 14,
          height: 50,
          marginTop: 8,
        }}
      >
        <Icon name="lock" color={k.text} />
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="sudo password"
          placeholderTextColor={k.mute}
          accessibilityLabel={`${name}'s sudo password`}
          style={{
            flex: 1,
            color: k.text,
            fontFamily: font.body,
            fontSize: 16,
            padding: 0,
            letterSpacing: password ? 3 : 0,
          }}
        />
      </View>
      {r.state === "wrong" ? (
        <Txt size={13} color={k.rose} style={{ marginTop: 8 }}>
          Wrong password, attempt {r.attempts} of {ATTEMPTS}
        </Txt>
      ) : null}
      {r.state === "checking" ? (
        <Txt size={13} color={k.amber} style={{ marginTop: 8 }}>
          Checking the password on the laptop…
        </Txt>
      ) : null}
      {error ? (
        <Txt size={13} color={k.rose} style={{ marginTop: 8 }}>
          {error}
        </Txt>
      ) : null}

      <Btn
        label={`Run ${chosen} command${chosen === 1 ? "" : "s"} as root`}
        kind="danger"
        onPress={() => void answer(true)}
        disabled={!password || chosen === 0 || r.state === "checking"}
        busy={busy}
      />
      <Btn label="Deny" onPress={() => void answer(false)} disabled={busy} />
    </Sheet>
  );
}
