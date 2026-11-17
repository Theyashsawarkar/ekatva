/**
 * A level you set by touch (volume, brightness): a liquid gauge, tinted
 * glass filled to the level with a slow glowing wave for a surface
 * (~/Documents/mockups/ekatva-jyoti.html); tap or drag anywhere on it. Never below `min` (brightness
 * stops at 10, so the screen can't go black). Sends at most every 150 ms while you
 * drag, and once more when you let go.
 */
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import { Icon, type IconName } from "../icon";
import { Txt } from "../lac";
import { k } from "../theme";
import { useMotion } from "./motion";
import { Tile } from "./parts";

export function LevelTile({
  icon,
  label,
  value,
  onSet,
  min = 0,
}: {
  /** The lowest it goes (brightness: 10). */
  min?: number;
  icon: IconName;
  label: string;
  /** The laptop's own reading; null when it has none. */
  value: number | null;
  onSet: (v: number) => void;
}) {
  const [height, setHeight] = useState(1);
  const [width, setWidth] = useState(1);
  const [local, setLocal] = useState<number | null>(null);
  const sent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const motion = useMotion();
  // The liquid follows the finger through an Animated value (a native
  // transform, no re-render); the number re-renders at most ~10 times a second.
  const fill = useState(() => new Animated.Value(value ?? 0))[0];
  const shownAt = useRef(0);
  // A new reading from the laptop wins once you're not touching it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading clears what was set by hand
  useEffect(() => {
    if (!holding.current) setLocal(null);
  }, [value]);

  const disabled = value === null;
  const shown = local ?? value ?? 0;
  // A new reading (or a value set by hand) eases the liquid there.
  useEffect(() => {
    if (!holding.current)
      Animated.timing(fill, { toValue: shown, duration: 180, useNativeDriver: true }).start();
  }, [shown, fill]);
  const at = (y: number) =>
    Math.max(min, Math.round(Math.max(0, Math.min(1, (height - y) / height)) * 100));
  const send = (v: number, now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const wait = now ? 0 : Math.max(0, 150 - (Date.now() - sent.current));
    timer.current = setTimeout(() => {
      sent.current = Date.now();
      onSet(v);
    }, wait);
  };
  const set = (y: number, now = false) => {
    const v = at(y);
    fill.setValue(v);
    const t = Date.now();
    if (now || t - shownAt.current > 100) {
      shownAt.current = t;
      setLocal(v);
    }
    send(v, now);
  };

  const pan = usePanGesture({
    runOnJS: true,
    enabled: !disabled,
    activeOffsetY: [-6, 6],
    failOffsetX: [-24, 24],
    onActivate: (e) => {
      holding.current = true;
      set(e.y);
    },
    onUpdate: (e) => set(e.y),
    onDeactivate: (e) => {
      holding.current = false;
      set(e.y, true);
    },
  });
  const tap = useTapGesture({
    runOnJS: true,
    enabled: !disabled,
    onActivate: (e) => set(e.y, true),
  });
  const gesture = useCompetingGestures(pan, tap);

  return (
    <GestureDetector gesture={gesture}>
      <Tile
        style={{
          flex: 1,
          justifyContent: "flex-end",
          borderRadius: 999,
          backgroundColor: "#17131c",
          opacity: disabled ? 0.45 : 1,
        }}
        onLayout={(e) => {
          setHeight(e.nativeEvent.layout.height || 1);
          setWidth(e.nativeEvent.layout.width || 1);
        }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max: 100, now: shown }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => {
          if (disabled) return;
          const v = Math.max(
            min,
            Math.min(100, shown + (e.nativeEvent.actionName === "increment" ? 10 : -10)),
          );
          setLocal(v);
          send(v, true);
        }}
      >
        <Liquid fill={fill} height={height} width={width} run={motion && shown > 0} />
        <View style={{ alignItems: "center", gap: 3, paddingBottom: 22 }}>
          <Icon name={icon} size={22} color={k.brass2} />
          <Txt w="600" size={12.5} color={k.text}>
            {disabled ? "—" : shown}
          </Txt>
        </View>
      </Tile>
    </GestureDetector>
  );
}

/** One wave, twice as wide as the capsule, so sliding it by half loops. */
const wave = (w: number, y: number, amp: number) => {
  const step = w / 4;
  let d = `M0 ${y}`;
  for (let i = 0; i < 8; i++) d += ` q${step / 2} ${i % 2 ? amp : -amp} ${step} 0`;
  return d;
};

function Drift({
  width,
  ms,
  run,
  children,
}: {
  width: number;
  ms: number;
  run: boolean;
  children: React.ReactNode;
}) {
  const t = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (!run) return;
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: ms,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [ms, run, t]);
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: 0,
        top: -8,
        width: width * 2,
        height: 12,
        transform: [
          { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, -width] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The liquid: tinted glass up to the level, its surface a slow glowing wave.
 * The whole column slides up and down (native transform) instead of
 * changing height, so dragging never re-lays out the capsule.
 */
function Liquid({
  fill,
  height,
  width,
  run,
}: {
  fill: Animated.Value;
  height: number;
  width: number;
  run: boolean;
}) {
  const w2 = width * 2;
  const top = wave(w2, 8, 4);
  const back = wave(w2, 7, 3.5);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height,
        transform: [
          { translateY: fill.interpolate({ inputRange: [0, 100], outputRange: [height, 0] }) },
        ],
        opacity: fill.interpolate({ inputRange: [0, 0.5, 100], outputRange: [0, 1, 1] }),
      }}
    >
      <LinearGradient
        colors={["rgba(227,207,169,0.34)", "rgba(227,207,169,0.10)"]}
        style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
      />
      <Drift width={width} ms={5200} run={run}>
        <Svg width={w2} height={12} style={{ opacity: 0.5, top: 2 }}>
          <Path d={`${back} V12 H0 Z`} fill="rgba(227,207,169,0.25)" />
        </Svg>
      </Drift>
      <Drift width={width} ms={3600} run={run}>
        <Svg width={w2} height={12}>
          <Path d={`${top} V12 H0 Z`} fill="rgba(227,207,169,0.3)" />
          {/* The glow, then the bright line on it. */}
          <Path d={top} stroke="rgba(227,207,169,0.35)" strokeWidth={5} fill="none" />
          <Path d={top} stroke={k.brass2} strokeWidth={2.2} fill="none" />
        </Svg>
      </Drift>
    </Animated.View>
  );
}
