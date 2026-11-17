import { type Entry, type JournalStore, type Problem, verify } from "@ekatva/protocol";
import { memo, useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { errorText } from "../../ui/errors";
import { Seg } from "../../ui/files/seg";
import { Icon } from "../../ui/icon";
import { l, Navbar, Page, Panel, Pill, Txt } from "../../ui/lac";
import { useApp, useLaptop, useLink } from "../../ui/state";
import { k } from "../../ui/theme";

type Side = "laptop" | "phone";

/** How many of the newest entries are shown (and kept on screen). */
const SHOWN = 300;
/** Where each log's chain was last checked up to: checked once, then only what's new. */
const checked = new Map<string, { last: Entry | null; problem: Problem | null }>();

/** Checks a log's chain from where it was last checked, a page at a time. */
async function check(key: string, store: JournalStore): Promise<Problem | null> {
  const from = checked.get(key) ?? { last: null, problem: null };
  if (from.problem) return from.problem;
  let last = from.last;
  for (;;) {
    const batch = await store.since(last?.seq ?? 0, 1000);
    if (!batch.length) break;
    const problem = verify(batch, last);
    if (problem) {
      checked.set(key, { last, problem });
      return problem;
    }
    last = batch.at(-1) ?? last;
  }
  checked.set(key, { last, problem: null });
  return null;
}

/**
 * A log, live: the newest entries once, then new ones as they're written
 * (the phone's journal says so), never re-reading it all. The laptop's log is read
 * from the laptop, a page at a time: the phone keeps no copy of it.
 */
function useLog(side: Side, laptopKey: string | undefined) {
  const { session } = useApp();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick reloads it (after an undo)
  useEffect(() => {
    if (!session) return;
    let live = true;
    let stop: (() => void) | null = null;
    const key = side === "phone" ? "phone" : `laptop:${laptopKey}`;
    void (async () => {
      if (side === "laptop") {
        // The laptop keeps its own log: read the newest page from it, and again every
        // 10 seconds while this tab is open (nothing is copied to the phone).
        const client = session.link.client;
        const load = async () => {
          const c = session.link.client ?? client;
          if (!c) return;
          const head = await c.journal.head.query();
          const page = await c.journal.since.query({
            after: Math.max(0, head.seq - SHOWN),
            limit: SHOWN,
          });
          if (live) setEntries(page as Entry[]);
        };
        await load().catch(() => undefined);
        const t = setInterval(() => void load().catch(() => undefined), 10_000);
        stop = () => clearInterval(t);
        return;
      }
      const store: JournalStore = session.journal.store;
      if (!live) return;
      const last = await store.last();
      const tail = await store.since(Math.max(0, (last?.seq ?? 0) - SHOWN), SHOWN);
      if (!live) return;
      setEntries(tail);
      setProblem(await check(key, store));
      const add = (fresh: Entry[]) => {
        if (!live || !fresh.length) return;
        setEntries((now) => [...now, ...fresh].slice(-SHOWN));
        void check(key, store).then((p) => live && setProblem(p));
      };
      const off = session.journal.onEntry((e) => add([e]));
      stop = () => off();
    })();
    return () => {
      live = false;
      stop?.();
    };
  }, [session, side, laptopKey, tick]);
  return { entries, problem, reload: () => setTick((n) => n + 1) };
}

/** Undoes an entry of the laptop's log, from here. */
async function undoOnLaptop(
  client:
    | { journal: { undo: { mutate(i: { seq: number }): Promise<{ summary: string }> } } }
    | null
    | undefined,
  seq: number,
): Promise<string> {
  if (!client) throw new Error("The laptop isn't connected");
  return (await client.journal.undo.mutate({ seq })).summary;
}

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
  const laptop = useLaptop();

  // The laptop's side is the verified copy kept on this phone: readable even offline.
  const { entries, problem, reload } = useLog(side, laptop?.key);
  const undone = useMemo(
    () => new Set(entries.filter((e) => e.undoes && e.ok).map((e) => e.undoes)),
    [entries],
  );
  const rows = useMemo(() => [...entries].reverse(), [entries]);

  const undo = async (e: Entry) => {
    if (!(await app.confirm(`Undo: ${e.summary}?`))) return;
    setNote(null);
    const done = side === "phone" ? app.undoHere(e.seq) : undoOnLaptop(client, e.seq);
    await done.then(
      (summary) => {
        setNote(summary);
        reload();
      },
      (err: unknown) => setNote(errorText(err)),
    );
  };

  const header = (
    <>
      <Navbar
        back="Settings"
        mid="Action log"
        right={
          entries.length ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name={problem ? "warn" : "check"} size={15} color={problem ? k.rose : k.sage} />
              <Txt size={13} color={problem ? k.rose : k.sage}>
                {problem ? `Broken at #${problem.seq}` : "Intact"}
              </Txt>
            </View>
          ) : null
        }
      />
      <Seg
        value={side}
        onChange={setSide}
        options={[
          { value: "laptop", label: laptop?.name ?? "Laptop" },
          { value: "phone", label: "This phone" },
        ]}
      />
      {note ? (
        <Panel style={{ padding: 14, marginBottom: 12, borderColor: `${k.brass}73` }}>
          <Txt size={14}>{note}</Txt>
        </Panel>
      ) : null}
    </>
  );
  return (
    <Page scroll={false}>
      {!entries.length ? (
        <>
          {header}
          <View style={{ alignItems: "center", paddingVertical: 48, gap: 8 }}>
            <Icon name="list" size={36} color={k.mute} />
            <Txt display w="600" size={19}>
              Nothing yet
            </Txt>
            <Txt size={14} color={k.sub} align="center">
              Every action on either device shows up here, and most can be undone.
            </Txt>
          </View>
        </>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(e) => String(e.seq)}
          ListHeaderComponent={header}
          ItemSeparatorComponent={Hair}
          renderItem={({ item: e, index }) => (
            <Row
              e={e}
              first={index === 0}
              last={index === rows.length - 1}
              undone={undone.has(e.seq)}
              canUndo={!!(e.ok && e.undo && !undone.has(e.seq) && (side === "phone" || !!client))}
              onUndo={undo}
            />
          )}
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </Page>
  );
}

function Hair() {
  return <View style={[l.hair, { marginHorizontal: 0 }]} />;
}

/** One entry: who and when, what, and Undo when it can be. Re-drawn only when it changes. */
const Row = memo(function Row({
  e,
  first,
  last,
  undone,
  canUndo,
  onUndo,
}: {
  e: Entry;
  first: boolean;
  last: boolean;
  undone: boolean;
  canUndo: boolean;
  onUndo: (e: Entry) => void;
}) {
  const tag = e.undoes
    ? { text: `undid #${e.undoes}`, color: k.brass2 }
    : !e.ok
      ? { text: e.error === "not granted" ? "refused" : "failed", color: k.rose }
      : undone
        ? { text: "undone", color: k.mute }
        : null;
  return (
    <View
      style={[
        { paddingVertical: 12, paddingHorizontal: 16, gap: 4, backgroundColor: k.ink2 },
        { borderColor: k.line, borderLeftWidth: 1, borderRightWidth: 1 },
        first ? { borderTopWidth: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20 } : null,
        last
          ? { borderBottomWidth: 1, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 }
          : null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Txt mono size={12} color={k.mute}>
          #{e.seq}
        </Txt>
        <Txt size={12.5} color={k.mute} style={{ flex: 1 }} lines={1}>
          {when(e.at)}, {e.actor.name}
        </Txt>
        {tag ? (
          <Txt size={12.5} w="600" color={tag.color}>
            {tag.text}
          </Txt>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Txt size={15} color={e.ok ? k.text : k.sub} style={{ flex: 1, lineHeight: 21 }}>
          {e.summary}
        </Txt>
        {canUndo ? <Pill label="Undo" onPress={() => onUndo(e)} /> : null}
      </View>
    </View>
  );
});
