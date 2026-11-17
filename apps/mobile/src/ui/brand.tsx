/** ekatva's face on its own screens: the mark, the name, and its verse. */
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, G, Mask, Path, Rect } from "react-native-svg";
import { Txt } from "./lac";
import { k } from "./theme";

/**
 * ekatva's mark, the same as its app icon and website: a laptop with a
 * phone in front of it (brass and steel), the phone cutting a clean gap
 * out of the laptop. Never the old two rings.
 */
export function Logo({
  size = 34,
  laptop = k.brass2,
  phone = k.steel,
}: {
  size?: number;
  laptop?: string;
  phone?: string;
}) {
  // The 64-unit drawing spans x 0–60 and y 12–58: crop the box to it.
  return (
    <Svg
      width={size}
      height={(size * 46) / 60}
      viewBox="0 12 60 46"
      fill="none"
      accessibilityLabel="ekatva"
    >
      <Defs>
        <Mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <Rect width="64" height="64" fill="#fff" />
          <Rect x="34" y="18" width="28" height="42" rx="8" fill="#000" />
        </Mask>
      </Defs>
      <G mask="url(#cut)">
        <Rect x="6" y="14" width="34" height="24" rx="4" stroke={laptop} strokeWidth={4} />
        <Path d="M2 44h42" stroke={laptop} strokeWidth={4} strokeLinecap="round" />
      </G>
      <Rect x="38" y="22" width="20" height="34" rx="5" stroke={phone} strokeWidth={4} />
      <Circle cx="48" cy="49" r="2.4" fill={phone} />
    </Svg>
  );
}

/** The mark, large, for the lock screen and setup. */
export function Mark({ size = 72 }: { size?: number }) {
  return (
    <View style={{ alignSelf: "center" }}>
      <Logo size={size * 1.45} />
    </View>
  );
}

export function Brand({ tagline = "Your phone and your laptop, as one." }: { tagline?: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <Mark />
      <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 26 }}>
        <Txt display w="700" size={38} style={{ letterSpacing: -0.76 }}>
          ekatva
        </Txt>
        <Txt deva size={24} color={k.brass} style={{ marginLeft: 8 }}>
          एकत्व
        </Txt>
      </View>
      <Txt size={13} color={k.sub} style={{ marginTop: 8 }}>
        {tagline}
      </Txt>
    </View>
  );
}

/** Īśa Upaniṣad 7, as in the README and on the website. */
export function Shloka() {
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 12 }}>
      <Txt deva size={15} color={k.sub} align="center" style={{ lineHeight: 25.5 }}>
        यस्मिन्सर्वाणि भूतान्यात्मैवाभूद्विजानतः ।{"\n"}तत्र को मोहः कः शोक एकत्वमनुपश्यतः ॥
      </Txt>
      <Txt size={12} color={k.mute} align="center" style={{ marginTop: 6 }}>
        Īśa Upaniṣad 7
      </Txt>
    </View>
  );
}

/** The lock screen's light: a soft plum glow above the middle, fading into ink. */
export function LockGlow() {
  // A native radial gradient: no full-screen SVG bitmap drawn before the first unlock.
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: k.ink,
          experimental_backgroundImage: `radial-gradient(circle at 50% 30%, #2a2231 0%, ${k.ink} 65%)`,
        },
      ]}
      pointerEvents="none"
    />
  );
}
