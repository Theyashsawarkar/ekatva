/** Markdown as agents write it (core/markdown.ts), drawn in the app's type: text you can select and copy. */
import * as Clipboard from "expo-clipboard";
import { memo, useMemo } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { type Md, markdown, type Span } from "../core/markdown";
import { Txt, toast } from "./lac";
import { font, k } from "./theme";

function Spans({ spans }: { spans: Span[] }) {
  return spans.map((s, i) => (
    <Text
      // biome-ignore lint/suspicious/noArrayIndexKey: spans of one fixed text
      key={i}
      onPress={
        s.href ? () => void Linking.openURL(s.href as string).catch(() => undefined) : undefined
      }
      style={[
        s.bold ? { fontFamily: font.bold } : null,
        s.italic ? { fontStyle: "italic" } : null,
        s.code ? { fontFamily: font.mono, fontSize: 13.5, color: k.brass2 } : null,
        s.href ? { color: k.steel, textDecorationLine: "underline" } : null,
      ]}
    >
      {s.text}
    </Text>
  ));
}

export function Code({ text, lang = "" }: { text: string; lang?: string }) {
  return (
    <View
      style={{
        backgroundColor: k.term,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: k.line,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingTop: 8,
        }}
      >
        <Txt size={12} color={k.mute}>
          {lang || "code"}
        </Txt>
        <Pressable
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Copy the code"
          onPress={() => void Clipboard.setStringAsync(text).then(() => toast("Copied"))}
        >
          <Txt size={12} color={k.brass2}>
            Copy
          </Txt>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 12 }}
      >
        <Txt mono size={12.5} color="#e6dfd5" style={{ lineHeight: 18 }}>
          {text}
        </Txt>
      </ScrollView>
    </View>
  );
}

function Block({ m }: { m: Md }) {
  switch (m.kind) {
    case "h":
      return (
        <Txt
          display
          w="700"
          size={m.level === 1 ? 21 : m.level === 2 ? 18.5 : 16.5}
          style={{ marginTop: 6 }}
        >
          <Spans spans={m.spans} />
        </Txt>
      );
    case "li":
      return (
        <View style={{ flexDirection: "row", marginLeft: 2 + m.depth * 18 }}>
          <Txt color={k.brass} style={{ lineHeight: 24, minWidth: m.mark === "•" ? 16 : 24 }}>
            {m.mark}
          </Txt>
          <Txt style={{ flex: 1, lineHeight: 24 }}>
            <Spans spans={m.spans} />
          </Txt>
        </View>
      );
    case "quote":
      return (
        <View
          style={{ borderLeftWidth: 3, borderLeftColor: k.line2, paddingLeft: 12, borderRadius: 2 }}
        >
          <Txt color={k.sub} style={{ lineHeight: 24 }}>
            <Spans spans={m.spans} />
          </Txt>
        </View>
      );
    case "code":
      return <Code text={m.text} lang={m.lang} />;
    case "hr":
      return <View style={{ height: 1, backgroundColor: k.line, marginVertical: 4 }} />;
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View
            style={{ borderWidth: 1, borderColor: k.line, borderRadius: 14, overflow: "hidden" }}
          >
            {[m.head, ...m.rows].map((r, y) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of one fixed table
                key={y}
                style={{
                  flexDirection: "row",
                  backgroundColor: y ? "transparent" : k.ink2,
                  borderTopWidth: y ? 1 : 0,
                  borderTopColor: k.line,
                }}
              >
                {m.head.map((_, x) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns of one fixed table
                  <View key={x} style={{ width: 150, padding: 10 }}>
                    <Txt size={14} w={y ? "400" : "600"} style={{ lineHeight: 20 }}>
                      <Spans spans={r[x] ?? []} />
                    </Txt>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    default:
      return (
        <Txt style={{ lineHeight: 25 }}>
          <Spans spans={m.spans} />
        </Txt>
      );
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdown(text), [text]);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a message's blocks keep their order
        <Block key={i} m={m} />
      ))}
    </View>
  );
});
