/**
 * The terminal's screen: what tmux shows in the window, in its colours, with
 * the cursor as a brass block. The window keeps the laptop's width: the text
 * shrinks to fit it (down to a readable size), then scrolls sideways.
 */
import type { TerminalScreen } from "@ekatva/protocol";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { BG, FG, parseAnsi, type Run, type Style } from "../ansi";
import { font, k } from "../theme";

/** The design's size; smaller only to fit a wide window, never under MIN. */
const SIZE = 12.5;
const MIN = 7.5;
/** JetBrains Mono's advance, in em. */
const ADVANCE = 0.6;
const PAD = 12;

function textStyle(s: Style) {
  const fg = s.inverse ? (s.bg ?? BG) : (s.fg ?? FG);
  const bg = s.inverse ? (s.fg ?? FG) : s.bg;
  return {
    color: fg,
    ...(bg ? { backgroundColor: bg } : {}),
    ...(s.bold ? { fontFamily: font.monoSemi } : {}),
    ...(s.dim ? { opacity: 0.6 } : {}),
    ...(s.italic ? { fontStyle: "italic" as const } : {}),
    ...(s.underline ? { textDecorationLine: "underline" as const } : {}),
  };
}

const cursorStyle = { backgroundColor: k.brass, color: BG };

export function Pane({ screen, denied }: { screen: TerminalScreen | null; denied?: ReactNode }) {
  const [width, setWidth] = useState(0);
  const scroller = useRef<{ scrollToEnd(o?: { animated?: boolean }): void } | null>(null);
  const atBottom = useRef(true);

  // Rows and runs are positions on the screen: numbered once, here.
  const lines = useMemo(
    () =>
      parseAnsi(screen?.text ?? "").map((runs, n) => ({
        n,
        runs: runs.map((r, i) => ({ ...r, i })),
      })),
    [screen?.text],
  );
  const cols = screen?.cols ?? 0;
  const fit = cols && width ? (width - PAD * 2) / (cols * ADVANCE) : SIZE;
  const size = Math.max(MIN, Math.min(SIZE, Math.floor(fit * 10) / 10));
  const lineH = Math.round(size * 1.55 * 10) / 10;
  const wide = cols * size * ADVANCE + PAD * 2 > width + 1;
  const cursorRow = screen ? screen.above + screen.cursor.y : -1;

  const body = (
    <View style={{ padding: PAD, width: wide ? cols * size * ADVANCE + PAD * 2 : undefined }}>
      {lines.map(({ n, runs }) => (
        <Line
          key={n}
          runs={runs}
          size={size}
          lineH={lineH}
          cursor={n === cursorRow && screen ? screen.cursor.x : -1}
        />
      ))}
    </View>
  );

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: BG,
        borderWidth: 1,
        borderColor: k.line,
        borderRadius: 18,
        overflow: "hidden",
      }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityLabel="The terminal's screen"
    >
      {denied ?? (
        <ScrollView
          ref={scroller as never}
          showsVerticalScrollIndicator={false}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottom.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() =>
            atBottom.current && scroller.current?.scrollToEnd({ animated: false })
          }
        >
          {wide ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {body}
            </ScrollView>
          ) : (
            body
          )}
        </ScrollView>
      )}
    </View>
  );
}

/** The cursor's line: its runs, with the character under the cursor drawn as a block. */
function withCursor(runs: (Run & { i: number })[], x: number) {
  const out: ReactNode[] = [];
  let col = 0;
  let drawn = false;
  for (const r of runs) {
    const end = col + r.text.length;
    if (!drawn && x >= col && x < end) {
      const at = x - col;
      if (at)
        out.push(
          <Text key={`${r.i}a`} style={textStyle(r.style)}>
            {r.text.slice(0, at)}
          </Text>,
        );
      out.push(
        <Text key={`${r.i}c`} style={cursorStyle}>
          {r.text[at]}
        </Text>,
      );
      if (at + 1 < r.text.length)
        out.push(
          <Text key={`${r.i}b`} style={textStyle(r.style)}>
            {r.text.slice(at + 1)}
          </Text>,
        );
      drawn = true;
    } else
      out.push(
        <Text key={r.i} style={textStyle(r.style)}>
          {r.text}
        </Text>,
      );
    col = end;
  }
  if (!drawn) {
    out.push(" ".repeat(Math.max(0, x - col)));
    out.push(
      <Text key="c" style={cursorStyle}>
        {" "}
      </Text>,
    );
  }
  return out;
}

/** Columns and rows that fit a pane of this size at the design's text size (for new sessions). */
export function fitting(w: number, h: number) {
  return {
    cols: Math.max(20, Math.min(400, Math.floor((w - PAD * 2) / (SIZE * ADVANCE)))),
    rows: Math.max(5, Math.min(200, Math.floor((h - PAD * 2) / (SIZE * 1.55)))),
  };
}

type Runs = ReturnType<typeof parseAnsi>[number];

/**
 * One line of the screen. Re-drawn only when its text, the size or the cursor
 * on it changes: a clock ticking in a corner redraws one line, not the screen.
 */
const Line = memo(
  function Line({
    runs,
    size,
    lineH,
    cursor,
  }: {
    runs: (Runs[number] & { i: number })[];
    size: number;
    lineH: number;
    cursor: number;
  }) {
    return (
      <Text
        numberOfLines={1}
        style={{
          fontFamily: font.mono,
          fontSize: size,
          lineHeight: lineH,
          color: FG,
          includeFontPadding: false,
        }}
      >
        {cursor >= 0
          ? withCursor(runs, cursor)
          : runs.map((r) => (
              <Text key={r.i} style={textStyle(r.style)}>
                {r.text}
              </Text>
            ))}
        {runs.length ? "" : " "}
      </Text>
    );
  },
  (a, b) =>
    a.size === b.size &&
    a.lineH === b.lineH &&
    a.cursor === b.cursor &&
    a.runs.length === b.runs.length &&
    a.runs.every((r, i) => {
      const o = b.runs[i];
      return !!o && o.text === r.text && JSON.stringify(o.style) === JSON.stringify(r.style);
    }),
);
