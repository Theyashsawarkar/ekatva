/**
 * Jyoti (ज्योति, keeping the laptop awake), swiped: three panes side by side
 * (Śānta, Akhaṇḍa, Nandādīpa). Swipe left
 * for more awake, right for less; the panel follows the finger, stretches
 * at the ends and snaps. Polished (~/Documents/mockups/ekatva-jyoti.html, the
 * icons from ekatva-jyoti-icons.html): light from above and a vignette, the
 * level's colour glowing behind its lamp, a fine edge that catches the light,
 * a pill pager under the label. The lamp is the focus, 150 dp: Śānta's is
 * the diya unlit (lilac-grey), Akhaṇḍa's the diya (blue), Nandādīpa's the
 * samai (ember). Plain line drawings, like the app's other icons
 * (ui/icon.tsx).
 *
 * Cheap to keep on screen: the glow is a native radial gradient (no SVG
 * bitmap); only the pane you see draws its art and runs its loops (the
 * neighbours join while you drag); the loops stop when Home isn't in front,
 * the app isn't, or "remove animations" is on.
 */
import type { JyotiLevel } from "@ekatva/protocol";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import { Icon } from "../icon";
import { Txt } from "../lac";
import { k } from "../theme";
import { useMotion } from "./motion";

const LEVELS: JyotiLevel[] = ["off", "on", "high"];
const NAME: Record<JyotiLevel, string> = { off: "Śānta", on: "Akhaṇḍa", high: "Nandādīpa" };
/** Each level's lamp: the diya unlit, the diya, the samai. */
const LAMP = { off: "shanta", on: "akhanda", high: "nandadipa" } as const;
/** One line each: it sits under the lamp. */
const SAYS: Record<JyotiLevel, string> = {
  off: "Sleeps and locks as usual",
  on: "Awake until the lid shuts",
  high: "Awake with the lid closed",
};
/** The level's colour: lilac-grey, cool blue, ember. */
const COLOR: Record<JyotiLevel, string> = { off: k.rest, on: k.cool, high: k.ember };
const BG: Record<JyotiLevel, [string, string]> = {
  off: ["#221c2b", "#18141e"],
  on: ["#25304a", "#1a1d2c"],
  high: ["#3d261d", "#24171a"],
};
/** The light behind the art: a native radial gradient (rgba centre, fading out by ~46%). */
const GLOW: Record<JyotiLevel, string> = {
  off: "radial-gradient(circle, rgba(160,145,190,0.30) 0%, rgba(160,145,190,0) 46%)",
  on: "radial-gradient(circle, rgba(134,174,224,0.55) 0%, rgba(134,174,224,0) 46%)",
  high: "radial-gradient(circle, rgba(229,139,82,0.7) 0%, rgba(229,139,82,0) 46%)",
};
/** The edge: brighter at the top left, where the light falls. */
const RIM: Record<JyotiLevel, [string, string, string]> = {
  off: ["rgba(236,224,206,0.22)", "rgba(236,224,206,0.05)", "rgba(236,224,206,0.03)"],
  on: ["rgba(160,195,240,0.75)", "rgba(134,174,224,0.18)", "rgba(134,174,224,0.10)"],
  high: ["rgba(245,170,120,0.85)", "rgba(229,139,82,0.25)", "rgba(229,139,82,0.15)"],
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
  const motion = useMotion();

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
        style={[
          { flex: 1, borderRadius: 26 },
          level === "high" ? s.glowHigh : level === "on" ? s.glowOn : null,
        ]}
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
                <Pane
                  key={l}
                  level={l}
                  width={w}
                  drawn={n === i || dragging}
                  moving={motion && n === i}
                />
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
                  style={[
                    s.pill,
                    {
                      backgroundColor: color,
                      shadowColor: color,
                      transform: [{ translateX: pill }],
                    },
                  ]}
                />
              </View>
            </Pressable>
          </View>
        </LinearGradient>
      </View>
    </GestureDetector>
  );
}

/** The level's lamp, the tile's focus: large, its light breathing while in view. */
function LampArt({ level, run }: { level: JyotiLevel; run: boolean }) {
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (!run) {
      v.stopAnimation();
      v.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [run, v]);
  return (
    <Animated.View
      style={[s.art, { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }) }]}
      pointerEvents="none"
    >
      <Icon name={LAMP[level]} size={144} color={COLOR[level]} stroke={0.98} />
    </Animated.View>
  );
}

function Pane({
  level,
  width,
  drawn,
  moving,
}: {
  level: JyotiLevel;
  width: number;
  /** Draw the glow and art (the pane in view, or all while dragging). */
  drawn: boolean;
  /** Run its loops. */
  moving: boolean;
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
        <>
          {/* The level's light, behind the art. */}
          <View
            style={[s.glow, { experimental_backgroundImage: GLOW[level] }]}
            pointerEvents="none"
          />
          <LampArt level={level} run={moving} />
        </>
      ) : null}
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
        style={{
          marginTop: "auto",
          letterSpacing: -0.5,
          ...(level === "off"
            ? {}
            : {
                textShadowColor: `${color}73`,
                textShadowRadius: 16,
                textShadowOffset: { width: 0, height: 0 },
              }),
        }}
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
  glowOn: {
    elevation: 10,
    shadowColor: k.cool,
    shadowOpacity: 0.5,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 18 },
  },
  glowHigh: {
    elevation: 14,
    shadowColor: k.ember,
    shadowOpacity: 0.75,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 18 },
  },
  pane: {
    height: "100%",
    paddingTop: 14,
    paddingHorizontal: 15,
    paddingBottom: 15,
    overflow: "hidden",
  },
  // The lamp, the focus: 144 dp at the top right, all of it in view. Its base
  // ends ~113 dp down, clear of the name even with large text (a 115% font
  // scale puts the name's top near 126 dp) (~/Documents/mockups/
  // ekatva-jyoti-tile3.html, 4).
  art: { position: "absolute", right: 6, top: -16, width: 144, height: 144 },
  // Its light, centred on it: the radial gradient's 46% stop lands ~57 dp out.
  glow: { position: "absolute", right: -47, top: -69, width: 250, height: 250 },
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
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
});
