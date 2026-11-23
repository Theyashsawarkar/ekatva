/**
 * A level you set by touch (volume, brightness): a liquid gauge, tinted
 * glass filled to the level; tap or drag anywhere on it. Never below `min`
 * (brightness stops at 10, so the screen can't go black). Sends at most
 * every 150 ms while you drag, and once more when you let go.
 *
 * It flows like a liquid, all on the UI thread (Reanimated), so nothing on
 * the JS thread can make it stutter:
 *   - the finger moves the level directly (a gesture worklet), not through
 *     a re-render; the number under the icon follows ~10 times a second;
 *   - the surface is drawn every frame from two sine waves of different
 *     lengths and speeds, so it rolls instead of sliding as one stiff shape;
 *   - a quick change sloshes: the waves grow with how fast the level moved,
 *     then calm down; a new reading from the laptop springs there;
 *   - for a moment after you let go, the laptop's late readings (sent while
 *     you were dragging) are ignored, so the liquid never jumps back.
 * The liquid is clipped by its own capsule shape in the SVG, not by the
 * view's rounded corners (Android redrew that clip with each moving frame).
 */
import { useEffect, useId, useRef, useState } from "react";
import { View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import Svg, { ClipPath, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { Icon, type IconName } from "../icon";
import { Txt } from "../lac";
import { k } from "../theme";
import { useMotion } from "./motion";
import { Tile } from "./parts";

const APath = Animated.createAnimatedComponent(Path);

/** After you let go, the laptop's readings are ignored this long (they may be from mid-drag). */
const SETTLE_MS = 1500;
/** The spring a new level settles with: a little give, no wobble that lasts. */
const SPRING = { damping: 16, stiffness: 140, mass: 0.9 };

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
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [local, setLocal] = useState<number | null>(null);
  const sent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt = useRef(0);
  const touchedAt = useRef(0);
  const motion = useMotion();

  // On the UI thread: the level (0–100, not rounded, so it moves smoothly),
  // the capsule's size, whether a finger is on it, the slosh, and time.
  const level = useSharedValue(value ?? 0);
  const h = useSharedValue(1);
  const w = useSharedValue(1);
  const lo = useSharedValue(min);
  const holding = useSharedValue(false);
  const slosh = useSharedValue(0);
  const time = useSharedValue(0);
  const last = useSharedValue(value ?? 0);
  useEffect(() => {
    lo.value = min;
  }, [min, lo]);

  const disabled = value === null;
  const shown = local ?? value ?? 0;

  // A new reading from the laptop: spring there, unless you're touching it
  // or just did (then it's probably one of your own, late).
  useEffect(() => {
    if (value === null || holding.value) return;
    if (Date.now() - touchedAt.current < SETTLE_MS) return;
    setLocal(null);
    level.value = withSpring(value, SPRING);
  }, [value, holding, level]);

  // The surface's clock and the slosh's calming, every frame while it may move.
  const frame = useFrameCallback((f) => {
    const dt = Math.min(64, f.timeSincePreviousFrame ?? 16);
    time.value += dt;
    // How far the level moved this frame makes the waves rise; they calm in ~0.6 s.
    const moved = Math.abs(level.value - last.value);
    last.value = level.value;
    slosh.value = Math.min(9, slosh.value * Math.exp(-dt / 600) + moved * 0.9);
  }, false);
  useEffect(() => {
    frame.setActive(motion && !disabled);
  }, [motion, disabled, frame]);

  // From the gesture (UI thread) to here: the number, and sending it.
  const send = (v: number, now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const wait = now ? 0 : Math.max(0, 150 - (Date.now() - sent.current));
    timer.current = setTimeout(() => {
      sent.current = Date.now();
      onSet(v);
    }, wait);
  };
  const dragged = (v: number, now: boolean) => {
    touchedAt.current = Date.now();
    const t = Date.now();
    if (now || t - shownAt.current > 100) {
      shownAt.current = t;
      setLocal(v);
    }
    send(v, now);
  };

  const at = (y: number) => {
    "worklet";
    const f = Math.max(0, Math.min(1, (h.value - y) / h.value));
    return Math.max(lo.value, f * 100);
  };
  const pan = usePanGesture({
    enabled: !disabled,
    activeOffsetY: [-6, 6],
    failOffsetX: [-24, 24],
    onActivate: (e) => {
      "worklet";
      holding.value = true;
      level.value = at(e.y);
      scheduleOnRN(dragged, Math.round(level.value), false);
    },
    onUpdate: (e) => {
      "worklet";
      level.value = at(e.y);
      scheduleOnRN(dragged, Math.round(level.value), false);
    },
    onDeactivate: (e) => {
      "worklet";
      holding.value = false;
      // Let go between two steps: settle on the step, gently.
      const v = Math.round(at(e.y));
      level.value = withSpring(v, SPRING);
      scheduleOnRN(dragged, v, true);
    },
  });
  const tap = useTapGesture({
    enabled: !disabled,
    onActivate: (e) => {
      "worklet";
      const v = Math.round(at(e.y));
      level.value = withSpring(v, SPRING);
      scheduleOnRN(dragged, v, true);
    },
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
          const { width, height } = e.nativeEvent.layout;
          setSize({ w: width || 1, h: height || 1 });
          w.value = width || 1;
          h.value = height || 1;
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
          level.value = withSpring(v, SPRING);
          dragged(v, true);
        }}
      >
        <Liquid w={size.w} h={size.h} level={level} slosh={slosh} time={time} />
        <View style={{ alignItems: "center", gap: 3, paddingBottom: 22 }} pointerEvents="none">
          <Icon name={icon} size={22} color={k.brass2} />
          <Txt w="600" size={12.5} color={k.text}>
            {disabled ? "—" : shown}
          </Txt>
        </View>
      </Tile>
    </GestureDetector>
  );
}

type SV = { value: number };

/**
 * The surface at `x`: two sine waves of different lengths drifting at
 * different speeds (so it never repeats as one stiff shape), their height
 * breathing slowly, plus the slosh.
 */
function surface(x: number, w: number, base: number, t: number, amp: number, back: boolean) {
  "worklet";
  const k1 = (Math.PI * 2) / (w * (back ? 1.35 : 1.05));
  const k2 = (Math.PI * 2) / (w * (back ? 0.8 : 0.62));
  const p1 = t * (back ? -0.0016 : 0.0021);
  const p2 = t * (back ? 0.0011 : -0.0013) + (back ? 1.7 : 0);
  const breathe = 0.85 + 0.15 * Math.sin(t * 0.0007 + (back ? 2 : 0));
  return (
    base +
    amp * breathe * (0.65 * Math.sin(x * k1 + p1) + 0.35 * Math.sin(x * k2 + p2)) +
    (back ? 1.5 : 0)
  );
}

/** The liquid's outline: the wavy surface across, then down and back along the bottom. */
function shape(
  w: number,
  h: number,
  level: number,
  t: number,
  slosh: number,
  back: boolean,
  line: boolean,
) {
  "worklet";
  const base = h * (1 - level / 100);
  // Waves die down near empty and near full, so the ends look calm.
  const room = Math.min(1, level / 4, (100 - level) / 4 + 0.35);
  const amp = (3.2 + slosh) * Math.max(0, room);
  const n = 28;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const x = (w * i) / n;
    const y = surface(x, w, base, t, amp, back);
    d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return line ? d : `${d}L${w} ${h + 2}L0 ${h + 2}Z`;
}

function Liquid({
  w,
  h,
  level,
  slosh,
  time,
}: {
  w: number;
  h: number;
  level: SV;
  slosh: SV;
  time: SV;
}) {
  // Each capsule's own clip and gradient (volume's and brightness's differ in size).
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const back = useAnimatedProps(() => ({
    d: shape(w, h, level.value, time.value, slosh.value, true, false),
    opacity: level.value > 0.3 ? 1 : 0,
  }));
  const front = useAnimatedProps(() => ({
    d: shape(w, h, level.value, time.value, slosh.value, false, false),
    opacity: level.value > 0.3 ? 1 : 0,
  }));
  const line = useAnimatedProps(() => ({
    d: shape(w, h, level.value, time.value, slosh.value, false, true),
    opacity: level.value > 0.3 ? 1 : 0,
  }));
  return (
    <Svg
      width={w}
      height={h}
      style={{ position: "absolute", left: 0, top: 0 }}
      pointerEvents="none"
    >
      <Defs>
        <ClipPath id={`capsule${id}`}>
          <Rect x={0} y={0} width={w} height={h} rx={w / 2} ry={w / 2} />
        </ClipPath>
        {/* Brighter at the surface, fading to the bottom (the path's own box). */}
        <LinearGradient id={`glass${id}`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={k.brass2} stopOpacity={0.34} />
          <Stop offset="1" stopColor={k.brass2} stopOpacity={0.1} />
        </LinearGradient>
      </Defs>
      <APath
        animatedProps={back}
        fill={k.brass2}
        fillOpacity={0.12}
        clipPath={`url(#capsule${id})`}
      />
      <APath animatedProps={front} fill={`url(#glass${id})`} clipPath={`url(#capsule${id})`} />
      {/* The surface: a soft band, then the bright line on it. */}
      <APath
        animatedProps={line}
        stroke={k.brass2}
        strokeOpacity={0.3}
        strokeWidth={5}
        fill="none"
        clipPath={`url(#capsule${id})`}
      />
      <APath
        animatedProps={line}
        stroke={k.brass2}
        strokeWidth={2.2}
        strokeLinejoin="round"
        fill="none"
        clipPath={`url(#capsule${id})`}
      />
    </Svg>
  );
}
