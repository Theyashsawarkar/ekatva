/** Every root request and what became of it: here or on the laptop, ran, denied, expired. */
import { useState } from "react";
import { View } from "react-native";
import { Item, List, Sheet, Txt } from "../ui/lac";
import { answeredBy, lookOf, Outcome } from "../ui/root-outcome";
import { useApp, useLink, usePoll } from "../ui/state";
import { k } from "../ui/theme";

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

export default function RootHistory() {
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const history = usePoll(() => client?.root.history.query() ?? null, [client], 10_000);
  const [open, setOpen] = useState<string | null>(null);
  const list = history.data ?? [];
  const h = list.find((x) => x.id === open);
  return (
    <Sheet title="Root requests">
      {!client ? (
        <Txt size={14} color={k.sub} style={{ marginBottom: 12 }}>
          Not connected: the history is on the laptop.
        </Txt>
      ) : null}
      {history.error ? (
        <Txt size={14} color={k.rose} style={{ marginBottom: 12 }}>
          {history.error}
        </Txt>
      ) : null}
      {client && history.data && !list.length ? (
        <Txt size={14} color={k.sub} style={{ marginBottom: 12 }}>
          No root requests yet.
        </Txt>
      ) : null}
      {list.length ? (
        <List>
          {list.map((x) => {
            const look = lookOf(x);
            return (
              <Item
                key={x.id}
                glyph={look.icon}
                glyphColor={look.color}
                title={look.title}
                sub={`${x.requester}, ${answeredBy(x)}, ${when(x.at)}`}
                label={`${look.title}, ${answeredBy(x)}, for ${x.requester}`}
                onPress={() => setOpen(open === x.id ? null : x.id)}
                style={open === x.id ? { backgroundColor: k.plum } : undefined}
              />
            );
          })}
        </List>
      ) : null}
      {h ? (
        <View style={{ gap: 10, marginTop: 16 }}>
          {h.reason ? (
            <Txt size={15} color={k.sub} style={{ lineHeight: 22 }}>
              “{h.reason}”
            </Txt>
          ) : null}
          <Outcome h={h} />
        </View>
      ) : null}
      <Txt size={13} color={k.sub} style={{ marginTop: 14, lineHeight: 19 }}>
        Every request and how it ended, on both devices. Passwords are never kept.
      </Txt>
    </Sheet>
  );
}
