import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Button, Card, Chip, Empty, Screen, T } from "../../ui/kit";
import { LinkChip } from "../../ui/link-chip";
import { MediaCard } from "../../ui/media-card";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";

const LEVELS = [
  { level: "off", label: "Off" },
  { level: "on", label: "Caffeine" },
  { level: "high", label: "High" },
] as const;

export default function Home() {
  const { session, alerts, dismissAlert, confirm } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const status = usePoll(() => client?.status.query() ?? null, [client]);
  const caffeine = usePoll(() => client?.caffeine.get.query() ?? null, [client], 5000);
  const agents = usePoll(() => client?.agents.list.query() ?? null, [client], 2500);
  const laptop = session?.laptops.current();
  const waiting = (agents.data ?? []).filter((a) => a.question);
  // Root requests: only when this phone may answer them (else quietly nothing).
  const roots = usePoll(() => client?.root.pending.query().catch(() => []) ?? null, [client], 2000);

  if (link.status === "unpaired") {
    return (
      <Screen title="ekatva">
        <Empty
          icon="link"
          title="Pair with your laptop"
          detail="On the laptop, run `ekatva pair` (or open ekatva there), then scan the code."
          action={
            <Button
              label="Scan the code"
              kind="primary"
              icon="qr-code"
              onPress={() => router.push("/pair")}
            />
          }
        />
      </Screen>
    );
  }

  const setCaffeine = async (level: "off" | "on" | "high") => {
    if (!client) return;
    await client.caffeine.set.mutate({ level });
    caffeine.reload();
  };

  return (
    <Screen title={laptop?.name ?? "ekatva"} right={<LinkChip />}>
      {alerts.map((a, i) => (
        <Card key={a} tone="red">
          <T color={c.red}>{a}</T>
          <Button label="Dismiss" onPress={() => dismissAlert(i)} />
        </Card>
      ))}
      {(roots.data ?? []).map((r) => (
        <Card key={r.id} tone="red">
          <T weight="700" color={c.red}>
            ⚠ Root access · {r.requester}
          </T>
          <T color={c.sub}>
            wants to run {r.commands.length} command{r.commands.length === 1 ? "" : "s"} as root
            {r.reason ? `: ${r.reason}` : ""}
          </T>
          <Button
            label="Review"
            kind="danger"
            icon="shield-checkmark"
            onPress={() => router.push({ pathname: "/root/[id]", params: { id: r.id } })}
          />
        </Card>
      ))}
      {waiting.map((a) => (
        <Card key={a.id} tone="gold">
          <T weight="700" color={c.gold}>
            ◆ {a.agent === "claude" ? "Claude" : a.agent} needs you · {a.session}
          </T>
          <T color={c.sub}>{a.question?.text}</T>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {a.question?.options.slice(0, 2).map((o, i) => (
              <Button
                key={o.key}
                label={o.label.length > 22 ? `${o.label.slice(0, 20)}…` : o.label}
                kind={i === 0 ? "primary" : "plain"}
                onPress={() =>
                  void client?.agents.answer
                    .mutate({ id: a.id, option: o.key, questionHash: a.question?.hash ?? "" })
                    .then(agents.reload)
                }
              />
            ))}
            <Button
              label="Open"
              onPress={() => router.push({ pathname: "/agent/[id]", params: { id: a.id } })}
            />
          </View>
        </Card>
      ))}
      {status.data ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Card style={{ flex: 1 }}>
            <T size={22} weight="800">
              {status.data.battery ? `${status.data.battery.percent}%` : "—"}
            </T>
            <T size={12} color={c.subtle}>
              battery{status.data.battery?.charging ? " · charging" : ""}
            </T>
          </Card>
          <Card style={{ flex: 1 }}>
            <T size={22} weight="800">
              {status.data.cpu ?? "—"}%
            </T>
            <T size={12} color={c.subtle}>
              CPU{status.data.temperature ? ` · ${status.data.temperature}°C` : ""}
            </T>
          </Card>
          <Card style={{ flex: 1 }}>
            <T size={22} weight="800">
              {status.data.waiting}
            </T>
            <T size={12} color={c.subtle}>
              agents waiting
            </T>
          </Card>
        </View>
      ) : link.status === "online" ? null : (
        <Card>
          <T color={c.dim}>
            {link.status === "connecting"
              ? "Connecting…"
              : (link.status === "offline" && link.error) || "Not connected."}
          </T>
        </Card>
      )}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <T weight="700">Caffeine</T>
          <View style={{ flex: 1 }} />
          {caffeine.data?.until ? (
            <Chip
              label={`until ${new Date(caffeine.data.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            />
          ) : null}
        </View>
        <View
          style={{ flexDirection: "row", backgroundColor: c.overlay, borderRadius: 12, padding: 4 }}
        >
          {LEVELS.map((l) => {
            const on = caffeine.data?.level === l.level;
            return (
              <Pressable
                key={l.level}
                onPress={() => void setCaffeine(l.level)}
                disabled={!client}
                style={{
                  flex: 1,
                  paddingVertical: 9,
                  borderRadius: 9,
                  alignItems: "center",
                  backgroundColor: on ? (l.level === "high" ? c.gold : c.accent) : "transparent",
                }}
              >
                <T weight="700" color={on ? c.crust : c.sub}>
                  {l.label}
                </T>
              </Pressable>
            );
          })}
        </View>
        <T size={12} color={c.subtle}>
          {caffeine.data?.level === "high"
            ? "Stays on with the lid closed. Closing the lid still locks it."
            : "High keeps it running with the lid closed: for a long run in a bag."}
        </T>
      </Card>
      <MediaCard client={client ?? null} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button
          style={{ flex: 1 }}
          label="Lock"
          icon="lock-closed"
          disabled={!client}
          onPress={() => void client?.power.lock.mutate()}
        />
        <Button
          style={{ flex: 1 }}
          label="Sleep"
          icon="moon"
          disabled={!client}
          onPress={() =>
            void confirm("Put the laptop to sleep?").then(
              (ok) => ok && client?.power.suspend.mutate(),
            )
          }
        />
      </View>
    </Screen>
  );
}
