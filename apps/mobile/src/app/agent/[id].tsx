/**
 * One session: its whole history (live, older messages as you scroll up;
 * for agents without one, what their screen shows), its question (answer it
 * with one tap), what it's doing now, what's queued for it (Send now), and a
 * message box with Stop while it works. Tap its name to rename it.
 */
import type { AgentTranscript } from "@ekatva/protocol";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { hasOlder, type Row, rows } from "../../core/agent-feed";
import { cached } from "../../core/unchanged";
import { Blocks, stateOf } from "../../ui/agent-blocks";
import { nameOf, Spin } from "../../ui/agents/parts";
import { RenameSheet } from "../../ui/agents/rename";
import { paneOf } from "../../ui/agents/route";
import { HistoryRow } from "../../ui/agents/rows";
import { useFeed } from "../../ui/agents/use-feed";
import { errorText } from "../../ui/errors";
import { Icon } from "../../ui/icon";
import { Navbar, Pill, Txt, toast } from "../../ui/lac";
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
  const agents = usePoll(() => client?.agents.list.query() ?? null, [client], 1500, {
    key: "agents.list",
  });
  const a = agents.data?.find((x) => x.id === id);
  // Claude Code's own history; other agents are read from their screen.
  const rich = view === "chat" && a?.rich === true;
  const feed = useFeed(client ?? null, id, rich);
  const list = useMemo(() => rows(feed.feed?.items ?? []), [feed.feed?.items]);
  const chat = useRef<FlatList<Row>>(null);
  const [up, setUp] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // The conversation comes back whole only when it changed.
  const [talk] = useState(() => cached<AgentTranscript>());
  const convo = usePoll(
    () =>
      view === "chat" && a && !a.rich && client
        ? client.agents.transcript
            .query({ id, lines: 500, unless: talk.unless })
            .then((a) => talk.take(a))
        : null,
    [client, id, view, a?.rich],
    2000,
  );
  const tail = usePoll(
    () => (view === "terminal" ? (client?.agents.tail.query({ id, lines: 120 }) ?? null) : null),
    [client, id, view],
    2500,
  );
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
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
      agents.reload();
      convo.reload();
      tail.reload();
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    }
  };

  const send = (now = false) => {
    if (!reply.trim() || !client) return;
    setSending(true);
    if (now) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void act(() => client.agents.reply.mutate({ id, text: reply, now })).then((ok) => {
      if (ok) setReply("");
      setSending(false);
      atBottom.current = true;
      chat.current?.scrollToOffset({ offset: 0, animated: true });
    });
  };

  const working = a?.state === "working";
  const canSend = !!reply.trim() && !!client && !sending;

  const queued = rich ? (feed.feed?.queued ?? []) : [];
  const rename = (name: string) =>
    act(
      () =>
        client?.agents.rename.mutate({ id, name }) ?? Promise.reject(new Error("not connected")),
      "Renamed",
    );
  // Each answer a full-width button, the first filled.
  const question = a?.question ? (
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
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
          <Navbar
            back="Agents"
            onBack={() => (router.canGoBack() ? router.back() : router.replace("/agents"))}
            mid={
              <Pressable
                disabled={!a?.rich}
                onPress={() => setRenaming(true)}
                accessibilityRole="button"
                accessibilityLabel={
                  a ? `${nameOf(a)}, ${stateOf(a).says}${a.rich ? ", rename" : ""}` : "Agent"
                }
                hitSlop={8}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 1,
                  maxWidth: 210,
                }}
              >
                <Txt w="600" lines={1} style={{ flexShrink: 1 }}>
                  {a ? nameOf(a) : "Agent"}
                </Txt>
                {a?.rich ? <Icon name="pencil" size={14} color={k.mute} /> : null}
              </Pressable>
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

        {rich ? (
          <View style={{ flex: 1 }}>
            <FlatList
              ref={chat}
              inverted
              data={list}
              keyExtractor={(r) => r.key}
              renderItem={({ item }) => (
                <View style={{ paddingVertical: 8 }}>
                  <HistoryRow row={item} load={feed.output} />
                </View>
              )}
              contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 14 }}
              keyboardShouldPersistTaps="handled"
              onEndReached={() => void feed.older()}
              onEndReachedThreshold={1.2}
              maintainVisibleContentPosition={{
                minIndexForVisible: 1,
                autoscrollToTopThreshold: 120,
              }}
              onScroll={(e) => {
                const away = e.nativeEvent.contentOffset.y > 320;
                if (away !== up) setUp(away);
              }}
              scrollEventThrottle={100}
              initialNumToRender={14}
              windowSize={9}
              ListHeaderComponent={
                <View style={{ gap: 12, paddingTop: 8 }}>
                  {feed.feed?.status || working ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <Spin size={16} />
                      <Txt size={14} color={k.sage} lines={1} style={{ flex: 1 }}>
                        {feed.feed?.status ?? a?.activity ?? "Working"}
                      </Txt>
                    </View>
                  ) : null}
                  {(a?.background ?? []).map((b) => (
                    <Txt key={b.name} size={13} color={k.sub} lines={1} style={{ marginLeft: 26 }}>
                      <Txt size={13} w="600">
                        {b.name}
                      </Txt>{" "}
                      {b.activity}
                    </Txt>
                  ))}
                  {question}
                </View>
              }
              ListFooterComponent={
                <Txt
                  size={12.5}
                  color={feed.error ? k.rose : k.mute}
                  align="center"
                  style={{ padding: 14 }}
                >
                  {feed.error ??
                    (feed.loading
                      ? "Loading earlier messages…"
                      : !feed.feed
                        ? "Reading its history…"
                        : hasOlder(feed.feed)
                          ? "Earlier messages above"
                          : feed.feed.total
                            ? "The start of this session"
                            : "Nothing said yet")}
                </Txt>
              }
            />
            {up ? (
              <Pressable
                onPress={() => chat.current?.scrollToOffset({ offset: 0, animated: true })}
                accessibilityRole="button"
                accessibilityLabel="Go to the latest message"
                style={[
                  round,
                  {
                    position: "absolute",
                    right: 18,
                    bottom: 14,
                    backgroundColor: k.plum2,
                    borderWidth: 1,
                    borderColor: k.line2,
                  },
                ]}
              >
                <Icon name="down" size={20} color={k.text} />
              </Pressable>
            ) : null}
          </View>
        ) : (
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
            {question}
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
        )}

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
          {/* What waits for it: it can be told to take it now. */}
          {queued.length ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: `${k.amber}73`,
                backgroundColor: "#2b2228",
                paddingVertical: 10,
                paddingLeft: 14,
                paddingRight: 10,
              }}
            >
              <View style={{ flex: 1 }}>
                <Txt size={12.5} w="600" color={k.amber}>
                  {queued.length === 1
                    ? "Waiting for it to finish"
                    : `${queued.length} waiting for it to finish`}
                </Txt>
                <Txt size={13.5} color={k.sub} lines={2}>
                  {queued.join("  ·  ")}
                </Txt>
              </View>
              <Pill
                label="Send now"
                tone="amber"
                onPress={() =>
                  client && void act(() => client.agents.sendNow.mutate({ id }), "It takes it now")
                }
              />
            </View>
          ) : null}
          {working && rich && reply.trim() ? (
            <Txt size={12} color={k.mute} style={{ marginLeft: 6 }}>
              It's working: your message waits its turn. Hold send to have it taken now.
            </Txt>
          ) : null}
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
              onPress={() => send()}
              onLongPress={working && rich ? () => send(true) : undefined}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={working && rich ? "Send; hold to send now" : "Send"}
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
      {renaming && a ? (
        <RenameSheet name={nameOf(a)} onSave={rename} onClose={() => setRenaming(false)} />
      ) : null}
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
