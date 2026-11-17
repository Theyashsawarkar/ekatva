/**
 * The laptop's notifications, newest first: what popped up there while you
 * were away from it. Each shows its app's own icon, its title and body
 * (tap for all of it); urgent ones carry a rose mark. Chips narrow it to
 * one app. Opening this clears the bell's count.
 */
import type { LaptopNoteEntry } from "@ekatva/protocol";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { errorText } from "../ui/errors";
import { Glyph, Navbar, Page, Txt } from "../ui/lac";
import { markSeen } from "../ui/notes/seen";
import { useApp, useLaptop, useLink, usePoll } from "../ui/state";
import { k, r } from "../ui/theme";

const DAY = 86_400_000;

function dayOf(at: number, now: number): string {
  const d = new Date(at);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return "Today";
  if (at >= start.getTime() - DAY) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Markup some apps put in a body (<b>, <a>): as plain text. */
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export default function LaptopNotifications() {
  const { session } = useApp();
  const link = useLink();
  const laptop = useLaptop();
  const name = laptop?.name ?? "the laptop";
  const client = link.status === "online" ? session?.link.client : null;
  const notes = usePoll(() => client?.notifications.history.query() ?? null, [client], 10_000, {
    key: "notifications.history",
  });
  const [app, setApp] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const items = notes.data?.items ?? [];
  const icons = notes.data?.icons ?? {};
  const newest = items[0]?.at ?? 0;
  useEffect(() => {
    if (newest) markSeen(newest);
  }, [newest]);

  // The apps with the most notifications first, for the chips.
  const apps = useMemo(() => {
    const n = new Map<string, number>();
    for (const x of items) n.set(x.app, (n.get(x.app) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }, [items]);
  const shown = app ? items.filter((x) => x.app === app) : items;

  const now = Date.now();
  const days: { day: string; list: LaptopNoteEntry[] }[] = [];
  for (const x of shown) {
    const d = dayOf(x.at, now);
    const last = days[days.length - 1];
    if (last && last.day === d) last.list.push(x);
    else days.push({ day: d, list: [x] });
  }

  return (
    <Page bottom={48}>
      <Navbar back="Home" />
      <Txt display w="700" size={30} style={{ letterSpacing: -0.6, marginTop: 4 }}>
        From the laptop
      </Txt>
      <Txt size={14} color={k.sub} style={{ marginTop: 4, marginBottom: 14 }}>
        {client
          ? `What popped up on ${name}, newest first.`
          : `Not connected: the history is on ${name}.`}
      </Txt>

      {notes.error ? (
        <Txt size={14} color={k.rose} style={{ marginBottom: 12 }}>
          {/forbidden|not allowed|permission/i.test(notes.error)
            ? `This phone doesn't see ${name}'s notifications. Allow it on the laptop (ekatva, this phone, Notifications).`
            : errorText(notes.error)}
        </Txt>
      ) : null}

      {apps.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 6 }}
          style={{ marginHorizontal: -20, paddingHorizontal: 20, marginBottom: 6, flexGrow: 0 }}
        >
          <Chip label="All" count={items.length} on={app === null} onPress={() => setApp(null)} />
          {apps.map((a) => (
            <Chip
              key={a}
              label={a}
              count={items.filter((x) => x.app === a).length}
              on={app === a}
              onPress={() => setApp(app === a ? null : a)}
            />
          ))}
        </ScrollView>
      ) : null}

      {client && notes.data && !items.length ? (
        <View style={{ alignItems: "center", gap: 10, marginTop: 40 }}>
          <Glyph name="bell" color={k.sub} size={52} radius={16} />
          <Txt size={15} color={k.sub} align="center">
            Nothing from {name} yet.
          </Txt>
        </View>
      ) : null}

      {days.map(({ day, list }) => (
        <View key={day}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              marginTop: 18,
              marginBottom: 8,
              gap: 8,
            }}
          >
            <Txt display w="600" size={16} style={{ letterSpacing: -0.16 }}>
              {day}
            </Txt>
            <Txt mono size={12} color={k.mute}>
              {list.length}
            </Txt>
          </View>
          <View
            style={{
              backgroundColor: k.ink2,
              borderWidth: 1,
              borderColor: k.line,
              borderRadius: r.m,
              overflow: "hidden",
            }}
          >
            {list.map((x, i) => (
              <Row
                key={x.id + x.at}
                x={x}
                icon={x.icon ? icons[x.icon] : undefined}
                first={i === 0}
                open={open === x.id}
                onPress={() => setOpen(open === x.id ? null : x.id)}
              />
            ))}
          </View>
        </View>
      ))}
    </Page>
  );
}

function Chip({
  label,
  count,
  on,
  onPress,
}: {
  label: string;
  count: number;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${count}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        height: 36,
        paddingHorizontal: 14,
        borderRadius: 18,
        backgroundColor: on ? k.brass2 : pressed ? k.plum : "transparent",
        borderWidth: 1,
        borderColor: on ? k.brass2 : k.line2,
      })}
    >
      <Txt w="600" size={13.5} color={on ? k.ink : k.text} lines={1}>
        {label}
      </Txt>
      <Txt mono size={11.5} color={on ? k.ink : k.mute}>
        {String(count)}
      </Txt>
    </Pressable>
  );
}

function Row({
  x,
  icon,
  first,
  open,
  onPress,
}: {
  x: LaptopNoteEntry;
  icon?: string;
  first: boolean;
  open: boolean;
  onPress: () => void;
}) {
  const body = plain(x.body).trim();
  const urgent = x.urgency === 2;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${x.app}, ${urgent ? "urgent, " : ""}${x.title}, ${timeOf(x.at)}`}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 13,
        backgroundColor: pressed || open ? k.plum : "transparent",
        borderTopWidth: first ? 0 : 1,
        borderTopColor: k.line,
      })}
    >
      {icon ? (
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            backgroundColor: k.ink,
            borderWidth: 1,
            borderColor: k.line,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Image
            source={{ uri: `data:image/png;base64,${icon}` }}
            style={{ width: 26, height: 26 }}
          />
        </View>
      ) : (
        <Glyph name="bell" color={k.sub} size={38} radius={11} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Txt size={12.5} color={k.sub} lines={1} style={{ flexShrink: 1 }}>
            {x.app}
          </Txt>
          {urgent ? (
            <View
              style={{
                paddingHorizontal: 6,
                height: 18,
                borderRadius: 6,
                justifyContent: "center",
                backgroundColor: `${k.rose}26`,
              }}
            >
              <Txt mono size={10.5} color={k.rose}>
                urgent
              </Txt>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          <Txt mono size={11.5} color={k.mute}>
            {timeOf(x.at)}
          </Txt>
        </View>
        <Txt w="600" size={15} lines={open ? undefined : 1} style={{ marginTop: 3 }}>
          {x.title || x.app}
        </Txt>
        {body ? (
          <Txt
            size={13.5}
            color={k.sub}
            lines={open ? undefined : 2}
            style={{ marginTop: 2, lineHeight: 19 }}
          >
            {body}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}
