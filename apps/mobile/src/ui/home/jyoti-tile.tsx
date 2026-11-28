/**
 * Jyoti (ज्योति, keeping the laptop awake), swiped: three panes side by side
 * (Śānta, Akhaṇḍa, Nandādīpa). Swipe left for more awake, right for less;
 * the panel follows the finger, stretches at the ends and snaps.
 *
 * The mandala is the focus (2026-11-28, the user's pick): the bar's diya
 * ringed by fine petals, hanging off the tile's top right corner; no rings lit
 * for Śānta, two for Akhaṇḍa, three for Nandādīpa, in the diya's own colours
 * (sky, kesari: the waybar's). ui/jyoti-art.ts draws it, the same drawing as
 * Darpaṇa's card. A vector, so it's sharp; nothing is blurred (no glow, no
 * coloured shadow). Only the pane you see draws it (the neighbours join while
 * you drag).
 */
import type { JyotiLevel } from "@ekatva/protocol";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import { SvgXml } from "react-native-svg";
import { DIYA_COLOR, mandala } from "../jyoti-art";
import { Txt } from "../lac";
import { k } from "../theme";

const LEVELS: JyotiLevel[] = ["off", "on", "high"];
const NAME: Record<JyotiLevel, string> = { off: "Śānta", on: "Akhaṇḍa", high: "Nandādīpa" };
/** Each level's mandala, drawn once (the SVG text doesn't change). */
const ART: Record<JyotiLevel, string> = {
  off: mandala("off"),
  on: mandala("on"),
  high: mandala("high"),
};
/** One line each: it sits under the name. */
const SAYS: Record<JyotiLevel, string> = {
  off: "Sleeps and locks as usual",
  on: "Awake until the lid shuts",
  high: "Awake with the lid closed",
};
/** The level's colour, the diya's (the bar's): lilac, sky, kesari. */
const COLOR: Record<JyotiLevel, string> = DIYA_COLOR;
const BG: Record<JyotiLevel, [string, string]> = {
  off: ["#221d2a", "#16131b"],
  on: ["#13263b", "#0b141e"],
  high: ["#371c12", "#1b110d"],
};
/** The edge: brighter at the top left, where the light falls. */
const RIM: Record<JyotiLevel, [string, string, string]> = {
  off: ["rgba(236,224,206,0.22)", "rgba(236,224,206,0.05)", "rgba(236,224,206,0.03)"],
  on: ["rgba(143,214,236,0.70)", "rgba(143,214,236,0.18)", "rgba(143,214,236,0.10)"],
  high: ["rgba(247,176,125,0.80)", "rgba(247,176,125,0.24)", "rgba(247,176,125,0.14)"],
};
const TRACK = 30;
const PILL = 12;

export function JyotiTile({
  level,
  onSet,
  disabled,
}: {
  level: JyotiLevel;
  onSet: (l: JyotiLevel) => void;
  disabled?: boolean;
}) {
  const [w, setW] = useState(0);
  const i = LEVELS.indexOf(level);
  const x = useState(() => new Animated.Value(0))[0];
  // While a drag is on, the neighbouring panes draw their art too.
  const [dragging, setDragging] = useState(false);

  const snap = (to: number, after?: () => void) =>
    Animated.spring(x, {
      toValue: -to * w,
      useNativeDriver: true,
      damping: 22,
      stiffness: 200,
      mass: 0.9,
    }).start(() => after?.());
  // Follows the level (yours, or one set on the laptop).
  // biome-ignore lint/correctness/useExhaustiveDependencies: snap reads w and x
  useEffect(() => {
    if (!dragging && w) snap(i);
  }, [i, w]);

  const go = (to: number) => {
    const t = Math.max(0, Math.min(LEVELS.length - 1, to));
    snap(t, () => setDragging(false));
    if (t !== i) onSet(LEVELS[t] as JyotiLevel);
  };

  // The finger moves an Animated value only: no re-render per frame.
  const pan = usePanGesture({
    runOnJS: true,
    enabled: !disabled && w > 0,
    activeOffsetX: [-10, 10],
    failOffsetY: [-12, 12],
    onActivate: () => setDragging(true),
    onUpdate: (e) => {
      const dx = e.translationX;
      const edge = (i === 0 && dx > 0) || (i === LEVELS.length - 1 && dx < 0);
      x.setValue(-i * w + (edge ? dx / 3 : dx));
    },
    onDeactivate: (e) => {
      const dx = e.translationX;
      const far = Math.abs(dx) > w * 0.18 || Math.abs(e.velocityX) > 600;
      go(far ? i - Math.sign(dx) : i);
    },
  });

  const color = COLOR[level];
  const pill = w
    ? x.interpolate({
        inputRange: [-2 * w, 0],
        outputRange: [TRACK - PILL, 0],
        extrapolate: "clamp",
      })
    : 0;

  return (
    <GestureDetector gesture={pan}>
      <View
        style={{ flex: 1, borderRadius: 26 }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Jyoti, keep the laptop awake"
        accessibilityValue={{ text: `${NAME[level]}: ${SAYS[level]}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => go(i + (e.nativeEvent.actionName === "increment" ? 1 : -1))}
      >
        <LinearGradient
          colors={RIM[level]}
          locations={[0, 0.45, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.rim}
        >
          <View style={s.inner} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
            <Animated.View
              style={{
                flexDirection: "row",
                width: w * 3,
                height: "100%",
                transform: [{ translateX: x }],
              }}
            >
              {LEVELS.map((l, n) => (
                <Pane key={l} level={l} width={w} drawn={n === i || dragging} />
              ))}
            </Animated.View>

            {/* The pager: a pill on a track; a 48 dp target over it, tap a third to jump there. */}
            <Pressable
              onPress={(e) =>
                go(Math.floor(((e.nativeEvent.locationX - (TOUCH - TRACK) / 2) / TRACK) * 3))
              }
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Choose how awake the laptop stays"
              style={s.touch}
            >
              <View style={s.track}>
                <Animated.View
                  style={[s.pill, { backgroundColor: color, transform: [{ translateX: pill }] }]}
                />
              </View>
            </Pressable>
          </View>
        </LinearGradient>
      </View>
    </GestureDetector>
  );
}

function Pane({
  level,
  width,
  drawn,
}: {
  level: JyotiLevel;
  width: number;
  /** Draw the mandala (the pane in view, or all while dragging). */
  drawn: boolean;
}) {
  const color = COLOR[level];
  return (
    <LinearGradient
      colors={BG[level]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={[s.pane, { width }]}
    >
      {drawn ? (
        <View style={s.art} pointerEvents="none">
          <SvgXml xml={ART[level]} width="100%" height="100%" />
        </View>
      ) : null}
      {/* The words sit under the mandala's rings: a fade to the tile's own colour keeps them clear. */}
      <LinearGradient
        colors={[`${BG[level][1]}00`, BG[level][1]]}
        locations={[0, 0.55]}
        style={s.fade}
        pointerEvents="none"
      />
      {/* Light from above, and a vignette at the bottom. */}
      <LinearGradient
        colors={["rgba(255,255,255,0.06)", "rgba(255,255,255,0)"]}
        locations={[0, 0.38]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.32)"]}
        locations={[0.55, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <Txt w="700" size={11} color={color} style={{ letterSpacing: 1.6 }}>
        JYOTI
      </Txt>
      {/* Onest, not the display face: it has Akhaṇḍa's ṇ and ḍ. */}
      <Txt
        w="700"
        size={20}
        color={level === "off" ? k.text : color}
        style={{ marginTop: "auto", letterSpacing: -0.5 }}
      >
        {NAME[level]}
      </Txt>
      <Txt size={11.5} color="rgba(239,231,220,0.7)" style={{ marginTop: 3 }} lines={1}>
        {SAYS[level]}
      </Txt>
    </LinearGradient>
  );
}

const TOUCH = 48;

const s = StyleSheet.create({
  rim: { flex: 1, borderRadius: 26, padding: 1 },
  inner: { flex: 1, borderRadius: 25, overflow: "hidden", backgroundColor: "#1b1622" },
  pane: {
    height: "100%",
    paddingTop: 14,
    paddingHorizontal: 15,
    paddingBottom: 15,
    overflow: "hidden",
  },
  // The flame, the focus, bigger than the tile: 176 dp, running off its top
  // right edge (the pane clips it), so the tile reads as a window onto a fire
  // (~/Documents/mockups/ekatva-jyoti-crop.html, "off the right edge"). Its
  // left tongue starts ~95 dp in, clear of the JYOTI label and the pager.
  // The mandala's 200-unit box, its lamp 38 from the right edge and 40 down.
  art: { position: "absolute", right: -62, top: -60, width: 200, height: 200 },
  // Under the name and the line below it: from clear to the tile's colour.
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 74 },
  // The 48 dp target is centred on the 30 × 4 track, under the JYOTI label.
  touch: {
    position: "absolute",
    left: 15 - (TOUCH - TRACK) / 2,
    top: 37 - (TOUCH - 4) / 2,
    width: TOUCH,
    height: TOUCH,
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    width: TRACK,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(239,231,220,0.12)",
  },
  pill: {
    position: "absolute",
    top: 0,
    left: 0,
    width: PILL,
    height: 4,
    borderRadius: 2,
  },
});
