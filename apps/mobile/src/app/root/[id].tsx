import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Switch, View } from "react-native";
import { Button, Card, Chip, Field, Screen, s, T } from "../../ui/kit";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";

/**
 * A root request from the laptop: exactly the commands the window there
 * shows. Approving takes your fingerprint and your password; the window
 * on the laptop then checks it with sudo and runs what's ticked.
 */
export default function Root() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, confirm } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const pending = usePoll(() => client?.root.pending.query() ?? null, [client], 1500);
  const r = pending.data?.find((x) => x.id === id);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    if (!client || !r) return;
    if (
      approve &&
      !(await confirm(`Run ${r.commands.length - off.size} command(s) as root for ${r.requester}?`))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const allow = r.commands.map((_, i) => i).filter((i) => !off.has(i));
      await client.root.respond.mutate({
        id: r.id,
        approve,
        password: approve ? password : null,
        allow,
      });
      setPassword("");
      if (!approve) router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (pending.data && !r) {
    return (
      <Screen
        title="Root access"
        right={<Button label="Back" icon="chevron-back" onPress={() => router.back()} />}
      >
        <Card>
          <T>This request has been answered (here or on the laptop), or it expired.</T>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title="Root access"
      right={<Button label="Back" icon="chevron-back" onPress={() => router.back()} />}
    >
      {r ? (
        <>
          <Card tone="red">
            <T weight="800" size={16}>
              {r.requester} wants to run {r.commands.length} command
              {r.commands.length === 1 ? "" : "s"} as root
            </T>
            {r.reason ? <T color={c.sub}>{r.reason}</T> : null}
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Chip label={r.via} />
              {r.state === "checking" ? (
                <Chip label="checking the password…" tone="accent" />
              ) : null}
              {r.state === "wrong" ? (
                <Chip label={`wrong password (${r.attempts} of 3)`} tone="bad" />
              ) : null}
            </View>
          </Card>
          {r.commands.map((cmd, i) => (
            <Card key={`${cmd.cmd}\u0000${cmd.why}`}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Switch
                  value={!off.has(i)}
                  onValueChange={(v) => {
                    const next = new Set(off);
                    if (v) next.delete(i);
                    else next.add(i);
                    setOff(next);
                  }}
                  trackColor={{ true: c.accent, false: c.muted }}
                  thumbColor={c.text}
                />
                <T weight="600" style={{ flex: 1 }}>
                  {cmd.why || "no reason given"}
                </T>
              </View>
              <View style={{ backgroundColor: "rgba(0,0,0,0.35)", borderRadius: 10, padding: 9 }}>
                <T mono style={[s.mono, { color: c.teal }]}>
                  {cmd.cmd}
                </T>
              </View>
            </Card>
          ))}
          <T size={12} color={c.subtle}>
            Each ticked command runs as root on the laptop, from /, stopping at the first that
            fails. Your password goes end to end into the window on the laptop; it is never stored
            or logged.
          </T>
          <Field
            label="Your password (for sudo on the laptop)"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {error ? <T color={c.red}>{error}</T> : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              style={{ flex: 1 }}
              label="Deny"
              kind="danger"
              onPress={() => void answer(false)}
              disabled={busy}
            />
            <Button
              style={{ flex: 2 }}
              label={`Run ${r.commands.length - off.size} as root`}
              kind="primary"
              icon="finger-print"
              busy={busy || r.state === "checking"}
              disabled={!password || off.size === r.commands.length}
              onPress={() => void answer(true)}
            />
          </View>
        </>
      ) : (
        <T color={c.dim}>Loading…</T>
      )}
    </Screen>
  );
}
