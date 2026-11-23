/**
 * The laptop's notifications, newest first: what popped up there while you
 * were away from it. Each shows its app's own icon, its title and body
 * (tap for all of it); urgent ones carry a rose mark. Filter, at the top
 * right, narrows it to one app: a sheet lists them with their counts, and a
 * single pill under the title says which one is on (× clears it). Opening
 * this clears the bell's count.
 */
import type { LaptopNoteEntry } from "@ekatva/protocol";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Glyph, Item, List, Navbar, Page, Sheet, Txt } from "../ui/lac";
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
  const [picking, setPicking] = useState(false);

  const items = notes.data?.items ?? [];
  const icons = notes.data?.icons ?? {};
  const newest = items[0]?.at ?? 0;
  useEffect(() => {
    if (newest) markSeen(newest);
  }, [newest]);

  // The apps with the most notifications first, with their counts, for the filter.
  const apps = useMemo(() => {
    const n = new Map<string, number>();
    for (const x of items) n.set(x.app, (n.get(x.app) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
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

  const pick = (a: string | null) => {
    setApp(a);
    setPicking(false);
  };

  return (
    <>
      <Page bottom={48}>
        <Navbar
          back="Home"
          right={
            apps.length > 1 ? (
              <Pressable
                onPress={() => setPicking(true)}
                accessibilityRole="button"
                accessibilityLabel={app ? `Filter: ${app}` : "Filter by app"}
                hitSlop={10}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Icon name="filter" size={18} color={app ? k.brass2 : k.sub} />
                <Txt size={15} color={app ? k.brass2 : k.sub}>
                  Filter
                </Txt>
              </Pressable>
            ) : null
          }
        />
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

        {app ? (
          <Pressable
            onPress={() => pick(null)}
            accessibilityRole="button"
            accessibilityLabel={`Showing only ${app}. Show all`}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              height: 32,
              paddingLeft: 12,
              paddingRight: 10,
              marginBottom: 4,
              borderRadius: 16,
              backgroundColor: pressed ? k.plum : `${k.brass2}1f`,
              borderWidth: 1,
              borderColor: `${k.brass2}59`,
            })}
          >
            <Txt w="600" size={13.5} color={k.brass2} lines={1}>
              {app}
            </Txt>
            <Txt mono size={11.5} color={k.mute}>
              {String(shown.length)}
            </Txt>
            <Icon name="close" size={14} color={k.brass2} />
          </Pressable>
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
      {picking ? (
        <Sheet title="Show" onClose={() => setPicking(false)}>
          <List inset={16}>
            {[["All apps", items.length] as const, ...apps].map(([a, n], i) => {
              const on = i === 0 ? app === null : app === a;
              return (
                <Item
                  key={a}
                  title={a}
                  titleColor={on ? k.brass2 : undefined}
                  onPress={() => pick(i === 0 ? null : a)}
                  label={`${a}, ${n}`}
                  right={
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <Txt mono size={12} color={k.mute}>
                        {String(n)}
                      </Txt>
                      {on ? <Icon name="check" size={18} color={k.brass2} /> : null}
                    </View>
                  }
                />
              );
            })}
          </List>
        </Sheet>
      ) : null}
    </>
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
