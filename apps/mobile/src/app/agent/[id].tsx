import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Card, Chip, Field, Screen, s, T } from "../../ui/kit";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";

/** One session: its recent output, its question, a reply box. */
export default function Agent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const list = usePoll(() => client?.agents.list.query() ?? null, [client], 1500);
  const tail = usePoll(
    () => client?.agents.tail.query({ id, lines: 80 }) ?? null,
    [client, id],
    2500,
  );
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = list.data?.find((x) => x.id === id);

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      list.reload();
      tail.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Screen
      title={a?.session ?? "Agent"}
      right={<Button label="Back" icon="chevron-back" onPress={() => router.back()} />}
      scroll={false}
    >
      {a ? (
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip label={a.agent} />
          <Chip
            label={a.state}
            tone={a.state === "waiting" ? "warn" : a.state === "working" ? "ok" : "plain"}
          />
          <Chip label={a.project} />
        </View>
      ) : null}
      <ScrollView
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", borderRadius: 12 }}
        contentContainerStyle={{ padding: 10 }}
        ref={(r) => r?.scrollToEnd({ animated: false })}
      >
        <T mono style={s.mono}>
          {tail.data ?? "…"}
        </T>
      </ScrollView>
      {a?.question ? (
        <Card tone="gold">
          <T color={c.gold} weight="700">
            {a.question.text}
          </T>
          {a.question.options.map((o, i) => (
            <Button
              key={o.key}
              label={`${o.key} · ${o.label}`}
              kind={i === 0 ? "primary" : "plain"}
              style={{ justifyContent: "flex-start" }}
              onPress={() =>
                void act(() =>
                  client!.agents.answer.mutate({
                    id,
                    option: o.key,
                    questionHash: a.question?.hash ?? "",
                  }),
                )
              }
            />
          ))}
        </Card>
      ) : null}
      {error ? <T color={c.red}>{error}</T> : null}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <Field
            placeholder={`Reply to ${a?.agent === "claude" ? "Claude" : "it"}…`}
            value={reply}
            onChangeText={setReply}
            multiline
          />
        </View>
        <Button
          label="Send"
          kind="primary"
          icon="send"
          busy={sending}
          disabled={!reply.trim() || !client}
          onPress={() => {
            setSending(true);
            void act(() => client!.agents.reply.mutate({ id, text: reply })).then(() => {
              setReply("");
              setSending(false);
            });
          }}
        />
      </View>
      <Button
        label="Interrupt (Esc)"
        kind="danger"
        icon="stop"
        disabled={!client}
        onPress={() => void act(() => client!.agents.interrupt.mutate({ id }))}
      />
    </Screen>
  );
}
