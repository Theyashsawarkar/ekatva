/**
 * Light and dark, for the laptop and this phone: a lamp that hangs in the
 * tile. Tap the tile to switch the devices that follow; the lamp lights the
 * tile for light mode and goes out for dark. Two chips choose which devices
 * follow, each showing that device's own mode (they can differ).
 * Measured to the prototype's `.t-lamp`. The warm wash is a native radial
 * gradient (no full-tile SVG bitmap); the chips are 48 dp tall to touch.
 */
import type { AppearanceMode } from "@ekatva/protocol";
import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, Ellipse, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";
import { Icon } from "../icon";
import { Txt } from "../lac";
import { k } from "../theme";

export type Who = "ace" | "phone";

export function AppearanceTile({
  laptopName,
  ace,
  aceBlocked,
  phone,
  follow,
  onFollow,
  onTap,
}: {
  /** Why the laptop can't be read or switched from here, if it can't. */
  aceBlocked?: string | null;
  laptopName: string;
  /** Each device's mode now; null while unknown (or not allowed). */
  ace: AppearanceMode | null;
  phone: AppearanceMode | null;
  follow: Record<Who, boolean>;
  onFollow: (who: Who) => void;
  onTap: () => void;
}) {
  // The mode the tile shows: the first device that follows and whose mode is known.
  const lead = (follow.ace && ace) || (follow.phone && phone) || ace || phone;
  const lit = lead === "light";
  const glow = useState(() => new Animated.Value(lit ? 1 : 0))[0];
  useEffect(() => {
    Animated.timing(glow, { toValue: lit ? 1 : 0, duration: 420, useNativeDriver: true }).start();
  }, [lit, glow]);

  const who =
    follow.ace && follow.phone
      ? `${laptopName} and this phone`
      : follow.ace
        ? laptopName
        : follow.phone
          ? "This phone"
          : "Pick a device";

  const chip = (w: Who) => {
    const mode = w === "ace" ? ace : phone;
    const on = follow[w];
    const color = on ? k.text : "rgba(239,231,220,0.5)";
    return (
      <Pressable
        key={w}
        onPress={() => onFollow(w)}
        accessibilityRole="switch"
        accessibilityState={{ checked: on }}
        accessibilityLabel={`${w === "ace" ? laptopName : "This phone"} follows${mode ? `, now ${mode}` : ""}`}
        style={t.touch}
      >
        <View
          style={[
            t.chip,
            {
              borderColor: on ? "rgba(239,231,220,0.45)" : "rgba(239,231,220,0.18)",
              backgroundColor: on ? "rgba(15,12,19,0.45)" : "rgba(15,12,19,0.3)",
            },
          ]}
        >
          <Icon name={w === "ace" ? "laptop" : "phone"} size={13} color={color} />
          <Txt w="600" size={12} color={color}>
            {w === "ace" ? laptopName : "Phone"}
          </Txt>
          {w === "ace" && aceBlocked ? (
            <Icon name="lock" size={12} color={k.amber} />
          ) : mode ? (
            <Icon name={mode === "light" ? "sun" : "moon"} size={13} color={color} />
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="switch"
      accessibilityState={{ checked: lit }}
      accessibilityLabel={`Appearance: ${lead ?? "unknown"}. Tap to switch ${who}`}
      style={({ pressed }) => [t.tile, { opacity: pressed ? 0.92 : 1 }]}
    >
      {/* The lamp's warm light over the tile, from the top right. */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: glow, experimental_backgroundImage: WASH }]}
        pointerEvents="none"
      />

      <View style={{ zIndex: 2 }}>
        <Txt
          display
          w="700"
          size={26}
          color={lit ? "#f6e8cf" : k.text}
          style={{ letterSpacing: -0.5 }}
        >
          {lead === null ? "Light or dark" : lit ? "Light" : "Dark"}
        </Txt>
        {/* Waiting on you (amber): the laptop hasn't allowed this phone yet. */}
        <Txt
          size={12}
          color={follow.ace && aceBlocked ? k.amber : k.sub}
          lines={2}
          style={{ marginTop: 4, maxWidth: 210 }}
        >
          {follow.ace && aceBlocked ? aceBlocked : who}
        </Txt>
        {/* 48 dp touch rows; the pills themselves look as before. */}
        <View style={{ flexDirection: "row", gap: 6, marginTop: 16 - (48 - 27) / 2 }}>
          {chip("ace")}
          {chip("phone")}
        </View>
      </View>

      {/* The lamp: off underneath, the lit lamp fading in over it. */}
      <View style={t.lamp} pointerEvents="none">
        <Svg width={120} height={150} viewBox="0 0 120 150" style={StyleSheet.absoluteFill}>
          <Path d="M60 0 V24" stroke={k.mute} strokeWidth={1.5} />
          <Path d={SHADE} fill="#3a3242" stroke="#4a4150" strokeWidth={1.7} />
          <Ellipse cx={60} cy={57} rx={10} ry={5.5} fill="#2a2230" />
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: glow }]}>
          <Svg width={120} height={150} viewBox="0 0 120 150">
            <Defs>
              <LinearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#f2c97d" stopOpacity={0.34} />
                <Stop offset="1" stopColor="#f2c97d" stopOpacity={0} />
              </LinearGradient>
              <RadialGradient id="bulbGlow" cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#ffd690" stopOpacity={0.7} />
                <Stop offset="1" stopColor="#ffd690" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Path d="M38 56 L-14 150 H134 L82 56 Z" fill="url(#beam)" />
            <Path d="M60 0 V24" stroke={k.mute} strokeWidth={1.5} />
            <Path d={SHADE} fill="#e3cfa9" stroke="#f0dcb4" strokeWidth={1.7} />
            <Ellipse cx={60} cy={58} rx={20} ry={11} fill="url(#bulbGlow)" />
            <Ellipse cx={60} cy={57} rx={10} ry={5.5} fill="#fff3d6" />
          </Svg>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const WASH =
  "radial-gradient(circle at 76% 0%, rgba(242,201,125,0.42) 0%, rgba(242,201,125,0.06) 55%, rgba(29,24,36,1) 82%)";
const SHADE = "M32 56 C32 36 45 24 60 24 C75 24 88 36 88 56 Z";

const t = StyleSheet.create({
  tile: {
    minHeight: 132,
    padding: 16,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: k.line,
    backgroundColor: "#1a1520",
    overflow: "hidden",
    marginTop: 12,
  },
  touch: { minHeight: 48, justifyContent: "center" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 5,
    paddingLeft: 8,
    paddingRight: 9,
    borderRadius: 99,
    borderWidth: 1,
  },
  lamp: { position: "absolute", right: 30, top: 0, width: 120, height: 150 },
});
