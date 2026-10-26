import { type Entry, verify } from "@ekatva/protocol";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Card, Chip, Empty, Screen, T } from "../../ui/kit";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";

type Side = "laptop" | "phone";

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Both action logs: what happened, who asked, and undo. */
export default function Log() {
  const app = useApp();
  const { session } = app;
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [side, setSide] = useState<Side>("laptop");
  const [note, setNote] = useState<string | null>(null);
  const laptop = session?.laptops.current();

  const load = async (): Promise<Entry[]> => {
    if (!session) return [];
    if (side === "phone") return session.journal.since(0, 100_000);
    // The verified copy kept on this phone: readable even offline.
    if (!laptop) return [];
    const mirror = await session.mirrorOf(laptop.key);
    return mirror.store.since(0, 100_000);
  };
  const { data, reload } = usePoll(load, [session, side, laptop?.key], 3000);
  const entries = data ?? [];
  const problem = entries.length ? verify(entries) : null;
  const undone = new Set(entries.filter((e) => e.undoes && e.ok).map((e) => e.undoes));

  const undo = async (e: Entry) => {
    if (!(await app.confirm(`Undo: ${e.summary}?`))) return;
    setNote(null);
    try {
      const summary =
        side === "phone"
          ? await app.undoHere(e.seq)
          : (await client!.journal.undo.mutate({ seq: e.seq })).summary;
      setNote(summary);
      reload();
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <Screen
      title="Log"
      right={
        entries.length ? (
          <Chip
            label={problem ? `broken at #${problem.seq}` : "✓ intact"}
            tone={problem ? "bad" : "ok"}
          />
        ) : null
      }
    >
      <View
        style={{ flexDirection: "row", backgroundColor: c.overlay, borderRadius: 12, padding: 4 }}
      >
        {(["laptop", "phone"] as const).map((s) => (
          <Pressable
            key={s}
            onPress={() => setSide(s)}
            style={{
              flex: 1,
              paddingVertical: 9,
              borderRadius: 9,
              alignItems: "center",
              backgroundColor: side === s ? c.accent : "transparent",
            }}
          >
            <T weight="700" color={side === s ? c.crust : c.sub}>
              {s === "laptop" ? (laptop?.name ?? "Laptop") : "This phone"}
            </T>
          </Pressable>
        ))}
      </View>
      {note ? (
        <Card tone="accent">
          <T>{note}</T>
        </Card>
      ) : null}
      {!entries.length ? (
        <Empty
          icon="list"
          title="Nothing yet"
          detail="Every action on either device shows up here, and most can be undone."
        />
      ) : null}
      {[...entries]
        .reverse()
        .slice(0, 300)
        .map((e) => {
          const canUndo = e.ok && e.undo && !undone.has(e.seq) && (side === "phone" || !!client);
          return (
            <Card key={e.seq} style={{ paddingVertical: 10 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <T size={12} color={c.subtle} mono>
                  #{e.seq}
                </T>
                <T size={12} color={c.subtle}>
                  {when(e.at)} · {e.actor.name}
                </T>
                <View style={{ flex: 1 }} />
                {e.undoes ? (
                  <Chip label={`undid #${e.undoes}`} tone="accent" />
                ) : !e.ok ? (
                  <Chip label={e.error === "not granted" ? "refused" : "failed"} tone="bad" />
                ) : undone.has(e.seq) ? (
                  <Chip label="undone" />
                ) : null}
              </View>
              <T color={e.ok ? c.text : c.dim}>{e.summary}</T>
              {canUndo ? (
                <Button
                  label="Undo"
                  icon="arrow-undo"
                  style={{ alignSelf: "flex-start", paddingVertical: 7 }}
                  onPress={() => void undo(e)}
                />
              ) : null}
            </Card>
          );
        })}
    </Screen>
  );
}
