/**
 * An agent's conversation, drawn for a phone (the prototype's .msg-you,
 * .msg-them, .toolrow and .note): your words in a bubble on the right, its
 * words as plain readable text, tools folded into a row you can open.
 */

import type { AgentBlock, AgentSession } from "@ekatva/protocol";
import { memo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { blockKeys } from "../core/block-keys";
import { same } from "../core/equal";
import { Icon } from "./icon";
import { Txt } from "./lac";
import { k } from "./theme";

/** Prose with its lists: "- item" a bullet, deeper indents deeper, blank lines paragraphs. */
function Prose({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, i) => {
        const key = `${i}:${line.slice(0, 12)}`;
        if (!line.trim()) return <View key={key} style={{ height: 8 }} />;
        const depth = Math.floor((line.length - line.trimStart().length) / 2);
        const m = /^(\s*)([-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
        if (!m)
          return (
            <Txt key={key} style={{ lineHeight: 25, marginLeft: depth * 18 }}>
              {line.trim()}
            </Txt>
          );
        const numbered = /\d/.test(m[2] ?? "");
        return (
          <View key={key} style={{ flexDirection: "row", marginLeft: 4 + depth * 18 }}>
            <Txt style={{ lineHeight: 25, width: numbered ? 22 : 14 }}>{numbered ? m[2] : "•"}</Txt>
            <Txt style={{ flex: 1, lineHeight: 25 }}>{m[3]}</Txt>
          </View>
        );
      })}
    </View>
  );
}

/** A tool call, folded: what ran; tap to see its output. */
function Tool({ title, output }: { title: string; output: string }) {
  const [open, setOpen] = useState(false);
  const m = /^([\w.-]+(?:\s[\w.-]+)?)\((.*)\)?$/.exec(title);
  const name = m ? m[1] : null;
  const arg = m ? (m[2] ?? "").replace(/\)$/, "") : title;
  return (
    <Pressable
      onPress={() => output && setOpen(!open)}
      accessibilityRole={output ? "button" : undefined}
      accessibilityState={output ? { expanded: open } : undefined}
      accessibilityLabel={`${title}${output ? (open ? ", shown" : ", tap for its output") : ""}`}
      style={({ pressed }) => ({
        borderRadius: 14,
        borderWidth: 1,
        borderColor: k.line,
        paddingHorizontal: 12,
        paddingVertical: 9,
        backgroundColor: pressed ? k.ink2 : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name={name ? "term" : "list"} size={15} color={k.steel} />
        <Txt size={13.5} color={k.sub} lines={1} style={{ flex: 1 }}>
          {name ? (
            <Txt size={13.5} w="600" color={k.text}>
              {name}{" "}
            </Txt>
          ) : null}
          {arg}
        </Txt>
        {output ? (
          <Icon
            name="chev"
            size={16}
            color={k.mute}
            style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
          />
        ) : null}
      </View>
      {open ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          <Txt mono size={12} color={k.sub} style={{ lineHeight: 17 }}>
            {output}
          </Txt>
        </ScrollView>
      ) : null}
    </Pressable>
  );
}

export function Blocks({ blocks }: { blocks: AgentBlock[] }) {
  const keys = blockKeys(blocks);
  return (
    <View style={{ gap: 14 }}>
      {blocks.map((b, i) => (
        <Block key={keys[i]} b={b} />
      ))}
    </View>
  );
}

/** One block: re-drawn only when its own content changes, not when the conversation grows. */
const Block = memo(
  function Block({ b }: { b: AgentBlock }) {
    if (b.kind === "you")
      return (
        <View
          style={{
            alignSelf: "flex-end",
            maxWidth: "82%",
            backgroundColor: k.plum2,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderBottomRightRadius: 6,
            borderBottomLeftRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Txt style={{ lineHeight: 23 }}>{b.text}</Txt>
        </View>
      );
    if (b.kind === "says") return <Prose text={b.text} />;
    if (b.kind === "tool") return <Tool title={b.title} output={b.output} />;
    return (
      <Txt size={12.5} color={k.mute} align="center" style={{ marginVertical: 2 }}>
        {b.text}
      </Txt>
    );
  },
  (a, b) => same(a.b, b.b),
);

/** How a session's state reads, and its colour (the theme's meaning). */
export const STATE = {
  working: { label: "Working", color: k.sage },
  waiting: { label: "Asks you", color: k.amber },
  done: { label: "Finished", color: k.sage },
  idle: { label: "Idle", color: k.mute },
} as const;

/** How a session's state looks: its colour and words (for screen readers). */
export function stateOf(a: AgentSession) {
  if (a.question) return { color: k.amber, says: "asks you" };
  if (a.state === "working") return { color: k.sage, says: "working" };
  if (a.state === "done") return { color: k.sage, says: "finished" };
  return { color: k.mute, says: "idle" };
}
