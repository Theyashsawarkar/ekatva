/**
 * One session: its question on top (answer it with one tap), the
 * conversation (or its real terminal screen), what it's doing now, and a
 * message box with Stop while it works.
 */
import type { AgentTranscript } from "@ekatva/protocol";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { cached } from "../../core/unchanged";
import { Blocks, stateOf } from "../../ui/agent-blocks";
import { Spin } from "../../ui/agents/parts";
import { paneOf } from "../../ui/agents/route";
import { errorText } from "../../ui/errors";
import { Icon } from "../../ui/icon";
import { Navbar, Txt, toast } from "../../ui/lac";
import { markSeen } from "../../ui/seen";
import { useApp, useLink, usePoll } from "../../ui/state";
import { font, k } from "../../ui/theme";

const QUICK = ["Continue", "Run the tests", "Explain first"];

export default function Agent() {
  const id = paneOf(useLocalSearchParams<{ id: string }>().id);
  const { session } = useApp();
  const insets = useSafeAreaInsets();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const list = usePoll(() => client?.agents.list.query() ?? null, [client], 1500, {
    key: "agents.list",
  });
  // The conversation comes back whole only when it changed.
  const [talk] = useState(() => cached<AgentTranscript>());
  const convo = usePoll(
    () =>
      view === "chat" && client
        ? client.agents.transcript
            .query({ id, lines: 500, unless: talk.unless })
            .then((a) => talk.take(a))
        : null,
    [client, id, view],
    2000,
  );
  const tail = usePoll(
    () => (view === "terminal" ? (client?.agents.tail.query({ id, lines: 120 }) ?? null) : null),
    [client, id, view],
    2500,
  );
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const a = list.data?.find((x) => x.id === id);
  const who = a?.agent === "claude" ? "Claude" : "it";

  // Follow the bottom while you're there; leave you be when you scroll up to read.
  const scroller = useRef<{ scrollToEnd(o?: { animated?: boolean }): void } | null>(null);
  const atBottom = useRef(true);

  // Opening a finished session: it's no longer new.
  useEffect(() => {
    if (a?.state === "done" && session) void markSeen(session.platform.kv, a.id, a.since);
  }, [a?.state, a?.since, a?.id, session]);

  const act = async (f: () => Promise<unknown>, said?: string) => {
    try {
      await f();
      if (said) toast(said);
      list.reload();
      convo.reload();
      tail.reload();
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    }
  };

  const send = () => {
    if (!reply.trim() || !client) return;
    setSending(true);
    void act(() => client.agents.reply.mutate({ id, text: reply })).then((ok) => {
      if (ok) setReply("");
      setSending(false);
      atBottom.current = true;
    });
  };

  const working = a?.state === "working";
  const canSend = !!reply.trim() && !!client && !sending;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
          <Navbar
            back="Agents"
            onBack={() => (router.canGoBack() ? router.back() : router.replace("/agents"))}
            mid={
              <Txt w="600" lines={1} label={a ? `${a.session}, ${stateOf(a).says}` : undefined}>
                {a?.session ?? "Agent"}
              </Txt>
            }
            right={
              <Pressable
                onPress={() => setView(view === "chat" ? "terminal" : "chat")}
                accessibilityRole="button"
                accessibilityLabel={
                  view === "chat" ? "Show its terminal screen" : "Show the conversation"
                }
                hitSlop={10}
              >
                <Txt size={15} color={k.brass2}>
                  {view === "chat" ? "Terminal" : "Chat"}
                </Txt>
              </Pressable>
            }
          />
        </View>

        <ScrollView
          ref={scroller as never}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottom.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (atBottom.current) scroller.current?.scrollToEnd({ animated: false });
          }}
        >
          {/* The question, on top: each answer a full-width button, the first filled. */}
          {a?.question ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: `${k.amber}73`,
                borderRadius: 20,
                padding: 16,
                backgroundColor: "#2b2228",
                marginBottom: 18,
              }}
            >
              <Txt size={13} w="600" color={k.amber} style={{ marginBottom: 6 }}>
                {a.agent === "claude" ? "Claude asks you" : "It asks you"}
              </Txt>
              <Txt size={16.5} w="500" style={{ lineHeight: 23, marginBottom: 6 }}>
                {a.question.text}
              </Txt>
              {a.question.options.map((o, i) => (
                <Pressable
                  key={o.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Answer ${o.label}`}
                  onPress={() =>
                    client &&
                    void act(
                      () =>
                        client.agents.answer.mutate({
                          id,
                          option: o.key,
                          questionHash: a.question?.hash ?? "",
                        }),
                      `Answered: ${o.label.length > 24 ? `${o.label.slice(0, 22)}…` : o.label}`,
                    )
                  }
                  style={({ pressed }) => ({
                    marginTop: 8,
                    paddingVertical: 13,
                    paddingHorizontal: 14,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: i ? k.line2 : "transparent",
                    backgroundColor: i ? k.ink : k.text,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Txt size={15} w={i ? "400" : "600"} color={i ? k.text : k.ink}>
                    {o.key}. {o.label}
                  </Txt>
                </Pressable>
              ))}
            </View>
          ) : null}

          {view === "chat" ? (
            convo.data ? (
              convo.data.blocks.length ? (
                <Blocks blocks={convo.data.blocks} />
              ) : (
                <Txt size={12.5} color={k.mute} align="center">
                  Nothing said yet
                </Txt>
              )
            ) : (
              <Txt size={12.5} color={convo.error ? k.rose : k.mute} align="center">
                {convo.error ?? "Reading…"}
              </Txt>
            )
          ) : (
            // The real screen, unwrapped: scroll sideways for long lines.
            <View
              style={{
                backgroundColor: k.term,
                borderWidth: 1,
                borderColor: k.line,
                borderRadius: 20,
                padding: 12,
              }}
            >
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Txt mono size={11.5} color="#e6dfd5" style={{ lineHeight: 17 }}>
                  {tail.data ?? tail.error ?? "…"}
                </Txt>
              </ScrollView>
            </View>
          )}

          {view === "chat" && (convo.data?.status || (working && a?.activity)) ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                marginTop: 20,
                marginBottom: 4,
              }}
            >
              <Spin size={16} />
              <Txt size={14} color={k.sage} lines={1} style={{ flex: 1 }}>
                {convo.data?.status ?? a?.activity}
              </Txt>
            </View>
          ) : null}
          {view === "chat"
            ? (a?.background ?? []).map((b) => (
                <Txt
                  key={b.name}
                  size={13}
                  color={k.sub}
                  lines={1}
                  style={{ marginLeft: 26, marginTop: 2 }}
                >
                  <Txt size={13} w="600" color={k.text}>
                    {b.name}
                  </Txt>{" "}
                  {b.activity}
                </Txt>
              ))
            : null}
        </ScrollView>

        {/* The message box: quick replies when it waits for you, Stop while it works. */}
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 10,
            paddingBottom: 14 + insets.bottom,
            gap: 8,
          }}
        >
          <LinearGradient
            pointerEvents="none"
            colors={["rgba(22,18,27,0)", k.ink]}
            style={{ position: "absolute", left: 0, right: 0, top: -28, height: 38 }}
          />
          {a && !working && !a.question ? (
            <View style={{ flexDirection: "row", gap: 6 }}>
              {QUICK.map((q) => (
                <Pressable
                  key={q}
                  onPress={() => setReply(q)}
                  accessibilityRole="button"
                  accessibilityLabel={`Reply: ${q}`}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: k.line2,
                    paddingVertical: 7,
                    paddingHorizontal: 12,
                    backgroundColor: pressed ? k.plum : k.ink2,
                  })}
                >
                  <Txt size={13}>{q}</Txt>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
            <TextInput
              value={reply}
              onChangeText={setReply}
              placeholder={`Message ${who}`}
              placeholderTextColor={k.mute}
              multiline
              style={{
                flex: 1,
                maxHeight: 140,
                minHeight: 46,
                color: k.text,
                fontFamily: font.body,
                fontSize: 15,
                backgroundColor: k.ink2,
                borderWidth: 1,
                borderColor: k.line2,
                borderRadius: 22,
                paddingHorizontal: 16,
                paddingVertical: 12,
                textAlignVertical: "top",
              }}
            />
            {working ? (
              <Pressable
                onPress={() =>
                  client && void act(() => client.agents.interrupt.mutate({ id }), `Stopped ${who}`)
                }
                accessibilityRole="button"
                accessibilityLabel={`Stop ${who} (Esc)`}
                style={({ pressed }) => [
                  round,
                  { backgroundColor: k.rose, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Icon name="stop" size={20} color={k.onRose} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={send}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={({ pressed }) => [
                round,
                { backgroundColor: k.text, opacity: !canSend ? 0.4 : pressed ? 0.8 : 1 },
              ]}
            >
              {sending ? (
                <Spin size={18} color={k.ink} />
              ) : (
                <Icon name="up" size={20} color={k.ink} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const round = {
  width: 44,
  height: 44,
  borderRadius: 999,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  marginBottom: 1,
};
