import { router } from "expo-router";
import { View } from "react-native";
import { Button, Card, Chip, Empty, Row, Screen, T } from "../../ui/kit";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";

const TONE = { waiting: "warn", working: "ok", done: "accent", idle: "plain" } as const;
const SAY = { waiting: "asks", working: "working", done: "your turn", idle: "idle" } as const;

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export default function Agents() {
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const { data, error } = usePoll(() => client?.agents.list.query() ?? null, [client], 2000);

  return (
    <Screen
      title="Agents"
      right={
        client ? (
          <Button
            label="New"
            icon="add"
            kind="primary"
            onPress={() => router.push("/new-session")}
          />
        ) : null
      }
    >
      {!client ? (
        <Empty
          icon="cloud-offline"
          title="Not connected"
          detail="Agents show up when the phone reaches the laptop."
        />
      ) : null}
      {error ? (
        <Card tone="red">
          <T color={c.red}>{error}</T>
        </Card>
      ) : null}
      {client && data && !data.length ? (
        <Empty
          icon="sparkles"
          title="No agent sessions"
          detail="Claude Code, Codex, Aider or Gemini running in tmux show up here."
          action={
            <Button
              label="Start one"
              kind="primary"
              icon="add"
              onPress={() => router.push("/new-session")}
            />
          }
        />
      ) : null}
      {(data ?? []).map((a) => (
        <Card key={a.id} tone={a.question ? "gold" : undefined} style={{ padding: 4 }}>
          <Row
            title={a.session}
            detail={`${a.agent} · ${a.project} · ${ago(a.since)}${a.activity ? `\n${a.activity}` : ""}`}
            right={<Chip label={SAY[a.state]} tone={TONE[a.state]} />}
            onPress={() => router.push({ pathname: "/agent/[id]", params: { id: a.id } })}
          />
          {a.question ? (
            <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 6 }}>
              <T color={c.gold} weight="600">
                {a.question.text}
              </T>
              {a.question.options.map((o, i) => (
                <Button
                  key={o.key}
                  label={`${o.key} · ${o.label}`}
                  kind={i === 0 ? "primary" : "plain"}
                  style={{ justifyContent: "flex-start" }}
                  onPress={() =>
                    void client?.agents.answer.mutate({
                      id: a.id,
                      option: o.key,
                      questionHash: a.question?.hash ?? "",
                    })
                  }
                />
              ))}
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
