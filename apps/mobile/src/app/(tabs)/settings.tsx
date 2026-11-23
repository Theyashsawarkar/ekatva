import { CAPABILITIES, type Capability } from "@ekatva/protocol";
import Constants from "expo-constants";
import { router } from "expo-router";
import { Alert, View } from "react-native";
import { Glyph, H2, Item, List, Page, Pill, Toggle, Txt } from "../../ui/lac";
import { PhoneFeatures } from "../../ui/phone-features";
import { useApp, useLaptop, useLink, usePoll } from "../../ui/state";
import { k } from "../../ui/theme";

const PHONE_CAPS = (Object.keys(CAPABILITIES) as Capability[]).filter(
  (k) => CAPABILITIES[k].side === "phone",
);

export default function Settings() {
  const app = useApp();
  const { session } = app;
  const link = useLink();
  const laptop = useLaptop();

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

  const via = link.status === "online" ? link.via : null;
  const client = link.status === "online" ? session?.link.client : null;
  const history = usePoll(() => client?.root.history.query() ?? null, [client], 60_000);
  const today = new Date().toDateString();
  const rootsToday = (history.data ?? []).filter(
    (h) => new Date(h.at).toDateString() === today,
  ).length;
  const paired = laptop
    ? new Date(laptop.pairedAt).toLocaleDateString([], { day: "numeric", month: "long" })
    : "";
  const state = via
    ? `Connected ${via === "lan" ? "directly" : "from away"}, encrypted.`
    : link.status === "connecting"
      ? "Connecting…"
      : "Not connected.";

  // Reachable from anywhere: the phone knows the laptop's tunnel (learnt on
  // the same Wi-Fi, from its code, or from its mailbox).
  const away = laptop?.away;
  const [awayLabel, awayTone, awaySub]: [string, "sage" | "amber" | "rose", string] =
    away?.state === "missing"
      ? [
          "Off",
          "rose",
          `${away.problem ?? "The tunnel isn't installed"} on ${laptop?.name}: same Wi-Fi only`,
        ]
      : away?.state === "starting"
        ? ["Opening", "amber", `${laptop?.name} is opening its tunnel`]
        : laptop?.url
          ? ["Ready", "sage", "Leave the Wi-Fi and it comes back through the laptop's tunnel"]
          : ["Not yet", "amber", "Connect once on the same Wi-Fi, or scan the laptop's code"];

  return (
    <Page title="Settings">
      <List>
        {laptop ? (
          <Item
            glyph={<Glyph name="laptop" size={48} radius={14} color={via ? k.steel : k.sub} />}
            title={
              <Txt w="600" size={18} lines={1}>
                {laptop.name}
              </Txt>
            }
            sub={
              <View style={{ marginTop: 2, gap: 4 }}>
                <Txt size={13} color={k.sub}>
                  {state} Paired {paired}.
                </Txt>
                <Txt mono size={12} color={k.mute} label="The laptop's key, as paired">
                  {laptop.key.slice(0, 4)} {laptop.key.slice(4, 8)} {laptop.key.slice(8, 12)}{" "}
                  {laptop.key.slice(12, 16)}
                </Txt>
              </View>
            }
          />
        ) : (
          <Item
            glyph={<Glyph name="qr" size={48} radius={14} color={k.brass2} />}
            title="No laptop yet"
            sub="Pair one to start"
            chev
            onPress={() => router.push("/pair")}
          />
        )}
      </List>

      {laptop ? (
        <>
          <H2>Connection</H2>
          <List>
            <Item
              glyph={via === "tunnel" ? "globe" : via === "lan" ? "wifi" : "offline"}
              glyphColor={via ? k.sage : link.status === "connecting" ? k.amber : k.mute}
              title={
                via === "lan"
                  ? "On the same Wi-Fi"
                  : via === "tunnel"
                    ? "Through the tunnel"
                    : link.status === "connecting"
                      ? "Connecting…"
                      : "Not connected"
              }
              sub={
                via === "lan"
                  ? "Straight to the laptop, end-to-end encrypted"
                  : via === "tunnel"
                    ? "From another network, end-to-end encrypted"
                    : link.status === "offline" && link.error
                      ? link.error
                      : "It keeps trying by itself"
              }
            />
            <Item
              glyph="globe"
              glyphColor={awayTone === "sage" ? k.sage : awayTone === "amber" ? k.amber : k.rose}
              title="From anywhere"
              sub={awaySub}
              subLines={2}
              right={<Pill label={awayLabel} tone={awayTone} />}
            />
            <Item
              glyph="qr"
              glyphColor={k.brass2}
              title="Scan the laptop's code"
              sub="Connects from any network, no pairing again"
              chev
              onPress={() => router.push("/pair")}
            />
          </List>

          <H2>What {laptop.name} may do here</H2>
          <List inset={16}>
            {PHONE_CAPS.map((cap) => {
              const on = laptop.grants.includes(cap);
              return (
                <Item
                  key={cap}
                  title={CAPABILITIES[cap].title}
                  sub={CAPABILITIES[cap].detail}
                  subLines={2}
                  onPress={() => void toggle(cap, !on)}
                  label={CAPABILITIES[cap].title}
                  right={
                    <Toggle
                      on={on}
                      onChange={(v) => void toggle(cap, v)}
                      label={CAPABILITIES[cap].title}
                    />
                  }
                />
              );
            })}
          </List>
        </>
      ) : null}

      <PhoneFeatures />

      <H2>History</H2>
      <List>
        <Item
          glyph="shield"
          glyphColor={k.rose}
          title="Root requests"
          sub={history.data ? `${rootsToday} today` : undefined}
          chev
          onPress={() => router.push("/root-history")}
        />
        <Item glyph="list" title="Action log" chev onPress={() => router.push("/log")} />
      </List>

      <List inset={16} style={{ marginTop: 22 }}>
        <Item
          title={laptop ? "Pair another laptop" : "Pair with a laptop"}
          onPress={() => router.push("/pair")}
        />
        {laptop ? (
          <Item title={`Forget ${laptop.name}`} titleColor={k.rose} onPress={forget} />
        ) : null}
        <Item title="Lock ekatva now" onPress={() => app.lock()} />
      </List>
      <Txt size={13} color={k.sub} align="center" style={{ marginTop: 26 }}>
        ekatva {Constants.expoConfig?.version}
      </Txt>
    </Page>
  );
}
