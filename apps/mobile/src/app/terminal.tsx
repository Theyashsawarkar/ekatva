/**
 * A terminal on the laptop: its own tmux server, opening on the session you
 * used last (as every Vayu terminal does). Switch sessions from the chip at
 * the top, windows from the chips under it; the dock below has what a phone
 * keyboard lacks. Opening it asks for the fingerprint: it's a shell on your laptop.
 */

import type { TerminalScreen, TerminalSession, TerminalTab } from "@ekatva/protocol";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { cached } from "../core/unchanged";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Item, List, Navbar, Txt, toast } from "../ui/lac";
import { useApp, useLink, usePoll } from "../ui/state";
import { Dock, type DockAction } from "../ui/terminal/dock";
import { fitting, Pane } from "../ui/terminal/pane";
import { k } from "../ui/theme";

export default function Terminal() {
  const { session, confirm } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [box, setBox] = useState({ w: 350, h: 500 });
  const [detail, setDetail] = useState<Record<string, TerminalTab[]>>({});

  // A shell on the laptop: the fingerprint first (once).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void confirm("Open a terminal on the laptop").then(setAllowed);
  });

  const sessions = usePoll(
    () => (allowed ? (client?.terminal.sessions.query() ?? null) : null),
    [client, allowed],
    5000,
  );
  const all: TerminalSession[] = sessions.data ?? [];
  // The one you picked, else the one used last.
  const name = all.find((s) => s.name === chosen)?.name ?? all[0]?.name ?? null;
  const tabs = usePoll(
    () => (allowed && name ? (client?.terminal.tabs.query({ session: name }) ?? null) : null),
    [client, allowed, name],
    3000,
  );
  const list: TerminalTab[] = tabs.data ?? [];
  const current = list.find((t) => t.id === tab) ?? list.find((t) => t.active) ?? list[0];
  // The screen comes back whole only when it changed (most ticks it hasn't).
  const [last] = useState(() => cached<TerminalScreen>());
  const screen = usePoll(
    () =>
      allowed && current && client
        ? client.terminal.screen
            .query({ id: current.id, history: 300, unless: last.unless })
            .then((a) => last.take(a))
        : null,
    [client, allowed, current?.id],
    350,
  );

  // The picker says what runs in each session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (!picker || !client) return;
    void Promise.all(
      all.map(
        async (s) => [s.name, await client.terminal.tabs.query({ session: s.name })] as const,
      ),
    ).then(
      (rows) => setDetail(Object.fromEntries(rows)),
      () => undefined,
    );
  }, [picker, client]);

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      screen.reload();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const act = (a: DockAction) => {
    if (!client || !current) return;
    const id = current.id;
    void run(() =>
      "keys" in a
        ? client.terminal.keys.mutate({ id, keys: a.keys })
        : "line" in a
          ? client.terminal.type.mutate({ id, text: a.line, enter: true })
          : "text" in a
            ? client.terminal.type.mutate({ id, text: a.text, enter: false })
            : client.terminal.action.mutate({ id, action: a.tmux }),
    );
  };
  const newWindow = () => {
    if (!client || !name) return;
    void run(async () => {
      const r = await client.terminal.newTab.mutate({ session: name });
      setTab(r.at(-1)?.id ?? null);
      tabs.reload();
      toast(`New window in ${name}`);
    });
  };
  const newSession = () => {
    if (!client) return;
    void run(async () => {
      const before = new Set(all.map((s) => s.name));
      const r = await client.terminal.newSession.mutate({ name: null, ...fitting(box.w, box.h) });
      const made = r.find((s) => !before.has(s.name));
      if (made) setChosen(made.name);
      setTab(null);
      setPicker(false);
      sessions.reload();
    });
  };
  const closeWindow = (t: TerminalTab) =>
    Alert.alert(`Close window ${t.index}?`, `${t.command} in ${name}. What runs there stops.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Close",
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await client?.terminal.closeTab.mutate({ id: t.id });
            setTab(null);
            tabs.reload();
            sessions.reload();
          }),
      },
    ]);

  const chip = (
    <Pressable
      onPress={() => setPicker(!picker)}
      disabled={!name}
      accessibilityRole="button"
      accessibilityLabel={`tmux session ${name ?? ""}, change it`}
      accessibilityState={{ expanded: picker }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: k.line2,
      }}
    >
      <Icon name="term" size={16} color={k.sage} />
      <Txt w="600" lines={1} style={{ maxWidth: 150 }}>
        {name ?? "tmux"}
      </Txt>
      <Icon
        name="chev"
        size={14}
        color={k.mute}
        style={{ transform: [{ rotate: picker ? "-90deg" : "90deg" }] }}
      />
    </Pressable>
  );

  const denied = /may not use/.test(sessions.error ?? tabs.error ?? "");
  const blocked = !client || allowed === false || denied;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }} edges={["top", "bottom"]}>
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
        <Navbar
          back="Home"
          onBack={() => router.back()}
          mid={chip}
          right={
            name ? (
              <Pressable
                onPress={newWindow}
                accessibilityRole="button"
                accessibilityLabel={`New window in ${name}`}
                hitSlop={10}
              >
                <Icon name="plus" size={20} color={k.brass2} />
              </Pressable>
            ) : null
          }
        />
        {picker ? (
          <List style={{ marginTop: -4, marginBottom: 12 }} inset={16}>
            {[
              ...all.map((s) => {
                const ws = detail[s.name];
                return (
                  <Item
                    key={s.name}
                    title={s.name}
                    sub={`${s.windows} window${s.windows === 1 ? "" : "s"}${ws ? `, ${ws.map((w) => w.command).join(", ")}` : ""}`}
                    right={s.name === name ? <Icon name="check" color={k.sage} /> : null}
                    onPress={() => {
                      setChosen(s.name);
                      setTab(null);
                      setPicker(false);
                    }}
                    label={`Session ${s.name}${s.attached ? ", open at the laptop" : ""}`}
                  />
                );
              }),
              <Item
                key="+"
                title={
                  <Txt w="600" size={15.5} color={k.brass2}>
                    New session
                  </Txt>
                }
                onPress={newSession}
                label="New tmux session"
              />,
            ]}
          </List>
        ) : null}

        {list.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, marginBottom: 8 }}
            contentContainerStyle={{ gap: 6 }}
          >
            {list.map((t) => {
              const on = t.id === current?.id;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setTab(t.id)}
                  onLongPress={() => closeWindow(t)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Window ${t.index}, ${t.command}`}
                  accessibilityHint="Hold to close it"
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: on ? k.line2 : k.line,
                    backgroundColor: on ? k.plum2 : "transparent",
                  }}
                >
                  <Txt size={13} color={on ? k.text : k.sub}>
                    {t.index} {t.command}
                  </Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View
          style={{ flex: 1 }}
          onLayout={(e) =>
            setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
          }
        >
          <Pane
            screen={screen.data}
            denied={
              blocked ? (
                <View
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: 24,
                  }}
                >
                  <Icon
                    name={!client ? "offline" : denied ? "lock" : "finger"}
                    size={34}
                    color={k.mute}
                  />
                  <Txt w="600">
                    {!client ? "Not connected" : denied ? "Not allowed yet" : "Not opened"}
                  </Txt>
                  <Txt size={13} color={k.sub} align="center">
                    {!client
                      ? "The terminal opens when the phone reaches the laptop."
                      : denied
                        ? "Allow “A terminal on the laptop” for this phone in the laptop's ekatva window (Phones)."
                        : "The terminal opens after your fingerprint."}
                  </Txt>
                </View>
              ) : undefined
            }
          />
        </View>

        <Dock onAction={act} />
      </View>
    </SafeAreaView>
  );
}
