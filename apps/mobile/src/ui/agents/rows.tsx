/** The rows of an agent's history: your words, its words, its steps folded, quiet notes. */
import type { AgentItem } from "@ekatva/protocol";
import * as Clipboard from "expo-clipboard";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import type { Row } from "../../core/agent-feed";
import { same } from "../../core/equal";
import { errorText } from "../errors";
import { Icon } from "../icon";
import { Txt, toast } from "../lac";
import { Code, Markdown } from "../markdown";
import { k } from "../theme";
import { Spin } from "./parts";

type Tool = Extract<AgentItem, { kind: "tool" }>;
/** A tool's whole output (the row holds the start of a long one). */
export type LoadOutput = (n: number) => Promise<string>;

const time = (at: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const copy = (text: string) =>
  void Clipboard.setStringAsync(text).then(() => toast("Copied the message"));

function Step({ t, load }: { t: Tool; load: LoadOutput }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const out = full ?? t.output;
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${t.name} ${t.title}, ${t.state === "ok" ? "done" : t.state}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 9,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {t.state === "running" ? (
          <Spin size={15} />
        ) : (
          <Icon
            name={t.state === "ok" ? "check" : "close"}
            size={15}
            color={t.state === "ok" ? k.sage : k.rose}
          />
        )}
        <Txt size={13.5} color={k.sub} lines={open ? undefined : 1} style={{ flex: 1 }}>
          <Txt size={13.5} w="600">
            {t.name}{" "}
          </Txt>
          {t.title}
        </Txt>
      </Pressable>
      {open ? (
        <View style={{ gap: 8, paddingBottom: 10 }}>
          {t.detail ? <Code text={t.detail} lang="what it ran" /> : null}
          {out ? <Code text={out} lang={t.state === "error" ? "error" : "output"} /> : null}
          {t.cut && full === null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void load(t.n).then(setFull, (e: unknown) => toast(errorText(e)))}
              hitSlop={8}
            >
              <Txt size={13} color={k.brass2}>
                Show all of it
              </Txt>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A run of tool calls: one line, its steps when opened. One that's running or failed says so. */
function Steps({ items, load }: { items: Tool[]; load: LoadOutput }) {
  const [open, setOpen] = useState(false);
  const last = items.at(-1) as Tool;
  const running = items.find((t) => t.state === "running");
  const failed = items.filter((t) => t.state === "error").length;
  const shown = running ?? last;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: k.line, paddingHorizontal: 12 }}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${items.length} steps, ${shown.name} ${shown.title}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 11,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {running ? <Spin size={15} /> : <Icon name="term" size={15} color={k.steel} />}
        <Txt size={13.5} color={k.sub} lines={1} style={{ flex: 1 }}>
          <Txt size={13.5} w="600">
            {shown.name}{" "}
          </Txt>
          {shown.title}
        </Txt>
        {failed ? (
          <Txt size={12.5} color={k.rose}>
            {failed} failed
          </Txt>
        ) : null}
        {items.length > 1 ? (
          <Txt size={12.5} color={k.mute}>
            {items.length} steps
          </Txt>
        ) : null}
        <Icon
          name="chev"
          size={15}
          color={k.mute}
          style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: k.line }}>
          {items.map((t) => (
            <Step key={t.n} t={t} load={load} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const HistoryRow = memo(
  function HistoryRow({ row, load }: { row: Row; load: LoadOutput }) {
    if (row.kind === "steps") return <Steps items={row.items} load={load} />;
    const it = row.item;
    if (it.kind === "you")
      return (
        <View style={{ alignSelf: "flex-end", maxWidth: "86%", alignItems: "flex-end" }}>
          <Pressable
            onLongPress={() => copy(it.text)}
            accessibilityLabel={`You: ${it.text}`}
            style={{
              backgroundColor: k.plum2,
              borderRadius: 20,
              borderBottomRightRadius: 6,
              paddingHorizontal: 15,
              paddingVertical: 10,
            }}
          >
            {it.images ? (
              <Txt size={13} color={k.sub}>
                {it.images === 1 ? "A picture" : `${it.images} pictures`}
              </Txt>
            ) : null}
            {it.text ? <Txt style={{ lineHeight: 23 }}>{it.text}</Txt> : null}
          </Pressable>
          <Txt size={11.5} color={k.mute} style={{ marginTop: 4, marginRight: 4 }}>
            {time(it.at)}
          </Txt>
        </View>
      );
    if (it.kind === "says")
      return (
        <Pressable onLongPress={() => copy(it.text)} delayLongPress={350}>
          <Markdown text={it.text} />
        </Pressable>
      );
    return (
      <Txt
        size={12.5}
        color={it.tone === "error" ? k.rose : k.mute}
        align="center"
        style={{ lineHeight: 18, paddingHorizontal: 14 }}
      >
        {it.text}
      </Txt>
    );
  },
  (a, b) => a.load === b.load && same(a.row, b.row),
);
