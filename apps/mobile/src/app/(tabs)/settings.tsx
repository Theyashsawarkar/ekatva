import { CAPABILITIES, type Capability } from "@ekatva/protocol";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Switch, View } from "react-native";
import { Vault } from "../../core/vault";
import { Button, Card, Field, Row, Screen, T } from "../../ui/kit";
import { LinkChip } from "../../ui/link-chip";
import { PhoneFeatures } from "../../ui/phone-features";
import { useApp, useLink } from "../../ui/state";
import { c } from "../../ui/theme";

const PHONE_CAPS = (Object.keys(CAPABILITIES) as Capability[]).filter(
  (k) => CAPABILITIES[k].side === "phone",
);

export default function Settings() {
  const app = useApp();
  const { session } = app;
  useLink();
  const laptop = session?.laptops.current();
  const [, bump] = useState(0);
  const [pw, setPw] = useState<{ old: string; next: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const toggle = async (cap: Capability, on: boolean) => {
    if (!laptop || !session) return;
    if (
      on &&
      CAPABILITIES[cap].risk === "high" &&
      !(await app.confirm(`Let ${laptop.name} ${CAPABILITIES[cap].title.toLowerCase()}?`))
    )
      return;
    const grants = on
      ? [...new Set([...laptop.grants, cap])]
      : laptop.grants.filter((g) => g !== cap);
    await session.laptops.update(laptop.key, { grants });
    await session.journal.record({
      actor: { key: "local", name: "you" },
      action: "settings.grants",
      summary: `${laptop.name} may ${on ? "now" : "no longer"}: ${CAPABILITIES[cap].title}`,
      input: { cap, on },
      ok: true,
    });
    bump((n) => n + 1);
  };

  const forget = () =>
    Alert.alert(
      `Forget ${laptop?.name}?`,
      "This phone stops trusting it. Pair again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () =>
            void app.confirm("Forget this laptop?").then(async (ok) => {
              if (ok && laptop) await session?.link.forget(laptop.key);
            }),
        },
      ],
    );

  return (
    <Screen title="Settings">
      {laptop ? (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <T weight="800" size={17}>
              {laptop.name}
            </T>
            <View style={{ flex: 1 }} />
            <LinkChip />
          </View>
          <T size={12} color={c.subtle} mono>
            key {laptop.key.slice(0, 4)} {laptop.key.slice(4, 8)} {laptop.key.slice(8, 12)} · paired{" "}
            {new Date(laptop.pairedAt).toLocaleDateString()}
          </T>
          <T size={12} color={c.subtle}>
            {laptop.lan.join(", ") || "no LAN address"}
          </T>
        </Card>
      ) : null}
      {laptop ? (
        <Card>
          <T weight="700">What {laptop.name} may do on this phone</T>
          {PHONE_CAPS.map((cap) => (
            <View
              key={cap}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}
            >
              <View style={{ flex: 1 }}>
                <T weight="600">{CAPABILITIES[cap].title}</T>
                <T size={12} color={c.subtle}>
                  {CAPABILITIES[cap].detail}
                </T>
              </View>
              <Switch
                value={laptop.grants.includes(cap)}
                onValueChange={(v) => void toggle(cap, v)}
                trackColor={{ true: c.accent, false: c.muted }}
                thumbColor={c.text}
              />
            </View>
          ))}
        </Card>
      ) : null}
      <PhoneFeatures />
      <Card style={{ padding: 4, gap: 0 }}>
        <Row
          icon="qr-code"
          title={laptop ? "Pair another laptop" : "Pair with a laptop"}
          onPress={() => router.push("/pair")}
        />
        {laptop ? <Row icon="unlink" title={`Forget ${laptop.name}`} onPress={forget} /> : null}
      </Card>
      <Card style={{ padding: 4, gap: 0 }}>
        <Row icon="lock-closed" title="Lock now" onPress={() => app.lock()} />
        <Row
          icon="key"
          title="Change the app password"
          onPress={() => setPw({ old: "", next: "" })}
        />
      </Card>
      {pw ? (
        <Card>
          <Field
            label="Current password"
            secureTextEntry
            value={pw.old}
            onChangeText={(old) => setPw({ ...pw, old })}
          />
          <Field
            label="New password"
            secureTextEntry
            value={pw.next}
            onChangeText={(next) => setPw({ ...pw, next })}
          />
          <Button
            label="Change"
            kind="primary"
            onPress={() =>
              void Vault.changePassword(session!.platform.kv, pw.old, pw.next).then(
                () => {
                  setPw(null);
                  setMsg("Password changed.");
                },
                (e: Error) => setMsg(e.message),
              )
            }
          />
        </Card>
      ) : null}
      {msg ? <T color={c.accent}>{msg}</T> : null}
      <T size={12} color={c.subtle} style={{ textAlign: "center", marginTop: 8 }}>
        ekatva {Constants.expoConfig?.version} · theyashsawarkar.github.io/ekatva
      </T>
    </Screen>
  );
}
