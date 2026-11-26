/**
 * The agents' small pieces (the prototype's .av, .spin, .asks): an avatar
 * with its state dot, the turning spinner, and the banner for something that
 * asks you (an agent's question, or root).
 */
import type { AgentSession } from "@ekatva/protocol";
import { useEffect, useState } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { useMotion } from "../home/motion";
import { Icon } from "../icon";
import { Pill, Txt } from "../lac";
import { k } from "../theme";

/** The state dot's colour: amber asks, sage working or finished, muted idle. */
export function dotOf(a: AgentSession): string {
  if (a.question) return k.amber;
  return a.state === "working" || a.state === "done" ? k.sage : k.mute;
}

/** "2 min", "3 h": how long ago. */
export const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "a moment" : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/** What the agent calls the session (a laptop from before that: tmux's name). */
export const nameOf = (a: AgentSession) => a.name || a.session;

export const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "~";

/** A rounded square with the name's first letter, and its state as a dot. */
export function Avatar({ a }: { a: AgentSession }) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 12,
        backgroundColor: k.plum2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Txt display w="700" size={17}>
        {nameOf(a).slice(0, 1).toUpperCase()}
      </Txt>
      <View
        style={{
          position: "absolute",
          right: -3,
          bottom: -3,
          width: 13,
          height: 13,
          borderRadius: 99,
          borderWidth: 2.5,
          borderColor: k.ink2,
          backgroundColor: dotOf(a),
        }}
      />
    </View>
  );
}

/** The spinner: an open circle, turning (still when the screen isn't in front, or with reduced motion). */
export function Spin({ size = 13, color = k.sage }: { size?: number; color?: string }) {
  const t = useState(() => new Animated.Value(0))[0];
  const motion = useMotion();
  useEffect(() => {
    if (!motion) return;
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [t, motion]);
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name="spin" size={size} color={color} />
    </Animated.View>
  );
}

/** The current time, every second (for counting down). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** dvarapala lets a root request wait this long. */
export const ROOT_EXPIRES_MS = 600_000;

/** "4:12": what's left of a root request's time. */
export function left(at: number, now: number): string {
  const s = Math.max(0, Math.round((at + ROOT_EXPIRES_MS - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Amber for an agent's question, rose for root: each mixed into ink2 as the prototype does. */
const ASKS = {
  amber: { color: k.amber, border: `${k.amber}73`, bg: "#2f2529", pill: "amber" as const },
  rose: { color: k.rose, border: `${k.rose}73`, bg: "#2d1f2a", pill: "rose" as const },
};

/** A banner for what asks you: a glowing dot, what and a line of detail, its button. */
export function Asks({
  tone,
  title,
  sub,
  action,
  onPress,
  style,
}: {
  tone: keyof typeof ASKS;
  title: string;
  sub: string;
  action: string;
  onPress: () => void;
  style?: object;
}) {
  const t = ASKS[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}. ${action}`}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.bg,
          opacity: pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <View
        style={{
          width: 17,
          height: 17,
          borderRadius: 99,
          backgroundColor: `${t.color}38`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View style={{ width: 9, height: 9, borderRadius: 99, backgroundColor: t.color }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt w="600" size={14.5} lines={1}>
          {title}
        </Txt>
        <Txt size={13} color={k.sub} lines={1}>
          {sub}
        </Txt>
      </View>
      <Pill label={action} tone={t.pill} onPress={onPress} />
    </Pressable>
  );
}
