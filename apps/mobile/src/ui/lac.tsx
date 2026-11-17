/**
 * The lacquer-and-brass kit: the prototype's pieces, measured to match it
 * (~/Documents/mockups/ekatva-prototype.html). Sizes are the prototype's
 * CSS pixels as dp. Every screen is built from these.
 */
import { router } from "expo-router";
import {
  Children,
  isValidElement,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./icon";
import { font, k, r } from "./theme";

/* ---------- type ---------- */

export type Weight = "400" | "500" | "600" | "700";
const ONEST: Record<Weight, string> = {
  "400": font.body,
  "500": font.medium,
  "600": font.semi,
  "700": font.bold,
};

/** Text in Onest (or `display` Bricolage, `mono` JetBrains Mono, `deva` Tiro). */
export function Txt({
  children,
  size = 16,
  w = "400",
  color = k.text,
  display,
  mono,
  deva,
  lines,
  style,
  align,
  label,
}: {
  children: ReactNode;
  size?: number;
  w?: Weight;
  color?: string;
  /** Bricolage Grotesque: 600 or 700 by `w`. */
  display?: boolean;
  mono?: boolean;
  deva?: boolean;
  lines?: number;
  style?: TextStyle | TextStyle[];
  align?: "left" | "center" | "right";
  label?: string;
}) {
  const family = deva
    ? font.deva
    : display
      ? w === "700"
        ? font.display
        : font.displaySemi
      : mono
        ? w === "600" || w === "700"
          ? font.monoSemi
          : font.mono
        : ONEST[w];
  return (
    <Text
      numberOfLines={lines}
      // Big display type stops growing at 1.4× (it sits in fixed tiles); body text scales freely.
      maxFontSizeMultiplier={display ? 1.4 : undefined}
      accessibilityLabel={label}
      style={[
        { fontFamily: family, fontSize: size, color, includeFontPadding: false },
        align ? { textAlign: align } : null,
        style as TextStyle,
      ]}
    >
      {children}
    </Text>
  );
}

/** The big page title (34, Bricolage 700). */
export function Title({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={l.titleRow}>
      <Txt display w="700" size={34} style={{ letterSpacing: -0.68, flex: 1 }}>
        {children}
      </Txt>
      {right}
    </View>
  );
}

/** A section heading (19, Bricolage 600). */
export function H2({ children, style }: { children: ReactNode; style?: TextStyle }) {
  return (
    <Txt
      display
      w="600"
      size={19}
      style={[{ marginTop: 26, marginBottom: 10, letterSpacing: -0.19 }, style ?? {}]}
    >
      {children}
    </Txt>
  );
}

/* ---------- pages ---------- */

/** A tab or full screen: the ink background, 20 at the sides, room for the tab bar below. */
export function Page({
  children,
  title,
  right,
  scroll = true,
  pad = true,
  bottom = 120,
}: {
  children: ReactNode;
  title?: string;
  right?: ReactNode;
  scroll?: boolean;
  /** Side padding (20). */
  pad?: boolean;
  /** Room under the last thing (the floating tab bar is 120). */
  bottom?: number;
}) {
  const body = (
    <>
      {title ? <Title right={right}>{title}</Title> : null}
      {children}
    </>
  );
  const padding: ViewStyle = {
    paddingTop: 6,
    paddingHorizontal: pad ? 20 : 0,
    paddingBottom: bottom,
  };
  return (
    <SafeAreaView style={l.page} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {scroll ? (
          <ScrollView
            contentContainerStyle={padding}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={[padding, { flex: 1 }]}>{body}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** A full screen's top bar: back (brass), a title in the middle, something on the right. */
export function Navbar({
  back = "Back",
  onBack,
  mid,
  right,
}: {
  back?: string;
  onBack?: () => void;
  mid?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={l.navbar}>
      <Pressable
        onPress={onBack ?? (() => router.back())}
        accessibilityRole="button"
        accessibilityLabel={back}
        hitSlop={10}
        style={[l.navSide, { flexDirection: "row", alignItems: "center", gap: 2 }]}
      >
        <Icon name="back" size={20} color={k.brass2} />
        <Txt size={15} color={k.brass2}>
          {back}
        </Txt>
      </Pressable>
      <View style={{ flex: 1, alignItems: "center" }}>
        {typeof mid === "string" ? (
          <Txt w="600" lines={1}>
            {mid}
          </Txt>
        ) : (
          mid
        )}
      </View>
      <View style={[l.navSide, { alignItems: "flex-end" }]}>{right}</View>
    </View>
  );
}

/* ---------- surfaces ---------- */

export function Panel({
  children,
  style,
}: {
  children?: ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  return <View style={[l.panel, style as ViewStyle]}>{children}</View>;
}

/** A grouped list: hairlines between the rows, from `inset` (62) to the edge. */
export function List({
  children,
  inset = 62,
  style,
}: {
  children: ReactNode;
  inset?: number;
  style?: ViewStyle;
}) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[l.panel, { overflow: "hidden" }, style]}>
      {rows.map((row, i) => (
        <View key={row.key ?? i}>
          {i ? <View style={[l.hair, { marginLeft: inset }]} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/** A row: a glyph, a title and a line under it, something on the right. */
export function Item({
  glyph,
  glyphColor,
  title,
  titleColor,
  sub,
  subLines = 1,
  right,
  chev,
  onPress,
  onLongPress,
  label,
  style,
}: {
  glyph?: IconName | ReactNode;
  glyphColor?: string;
  title: ReactNode;
  titleColor?: string;
  sub?: ReactNode;
  subLines?: number;
  right?: ReactNode;
  chev?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  label?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      style={({ pressed }) => [l.item, pressed ? { backgroundColor: k.plum } : null, style]}
    >
      {typeof glyph === "string" ? <Glyph name={glyph as IconName} color={glyphColor} /> : glyph}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === "string" ? (
          <Txt w="600" size={15.5} color={titleColor} lines={1}>
            {title}
          </Txt>
        ) : (
          title
        )}
        {sub ? (
          typeof sub === "string" ? (
            <Txt size={13} color={k.sub} lines={subLines} style={{ marginTop: 2 }}>
              {sub}
            </Txt>
          ) : (
            sub
          )
        ) : null}
      </View>
      {right}
      {chev ? <Icon name="chev" size={16} color={k.mute} /> : null}
    </Pressable>
  );
}

/** An icon in a small rounded square with a hairline edge. */
export function Glyph({
  name,
  color = k.text,
  size = 32,
  radius = 10,
}: {
  name: IconName;
  color?: string;
  size?: number;
  radius?: number;
}) {
  return (
    <View style={[l.glyph, { width: size, height: size, borderRadius: radius }]}>
      <Icon name={name} size={size >= 42 ? 22 : 17} color={color} />
    </View>
  );
}

/* ---------- controls ---------- */

const PILL = {
  amber: { bg: k.amber, fg: k.onAmber, border: "transparent" },
  rose: { bg: k.rose, fg: k.onRose, border: "transparent" },
  sage: { bg: k.sage, fg: k.onSage, border: "transparent" },
  ghost: { bg: "transparent", fg: k.text, border: k.line2 },
};

export function Pill({
  label,
  tone = "ghost",
  onPress,
}: {
  label: string;
  tone?: keyof typeof PILL;
  onPress?: () => void;
}) {
  const t = PILL[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      // 48 dp to touch, the pill itself as before.
      style={{ minHeight: 48, justifyContent: "center" }}
    >
      {({ pressed }) => (
        <View
          style={[
            l.pill,
            { backgroundColor: t.bg, borderColor: t.border, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Txt w="600" size={13.5} color={t.fg}>
            {label}
          </Txt>
        </View>
      )}
    </Pressable>
  );
}

const BTN = {
  solid: { bg: k.text, fg: k.ink, border: "transparent" },
  plain: { bg: k.plum, fg: k.text, border: k.line2 },
  danger: { bg: k.rose, fg: k.onRose, border: "transparent" },
};

/** A full-width button (the prototype's .btn). */
export function Btn({
  label,
  kind = "plain",
  onPress,
  disabled,
  busy,
  icon,
  style,
}: {
  label: string;
  kind?: keyof typeof BTN;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  style?: ViewStyle;
}) {
  const t = BTN[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => [
        l.btn,
        {
          backgroundColor: t.bg,
          borderColor: t.border,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={18} color={t.fg} /> : null}
      <Txt w="600" size={15} color={t.fg}>
        {busy ? "…" : label}
      </Txt>
    </Pressable>
  );
}

/** An on/off switch: plum off, sage on. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange?: (on: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  const x = useState(() => new Animated.Value(on ? 1 : 0))[0];
  useEffect(() => {
    Animated.timing(x, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  }, [on, x]);
  // All on the native driver: the sage track fades in over the plum one, the knob slides.
  const knob = x.interpolate({ inputRange: [0, 1], outputRange: [0, 20] });
  return (
    <Pressable
      onPress={() => onChange?.(!on)}
      disabled={disabled || !onChange}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled: !!disabled }}
      accessibilityLabel={label}
      style={{ opacity: disabled ? 0.45 : 1, minHeight: 48, justifyContent: "center" }}
    >
      <View style={[l.toggle, { backgroundColor: k.plum2 }]}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: 999, backgroundColor: k.sage, opacity: x },
          ]}
        />
        <Animated.View style={[l.knob, { left: 3, transform: [{ translateX: knob }] }]} />
      </View>
    </Pressable>
  );
}

/** A text field, with an optional label above it. */
export function Field(props: TextInputProps & { label?: string }) {
  return (
    <View style={{ gap: 6 }}>
      {props.label ? (
        <Txt size={12} w="600" color={k.sub}>
          {props.label}
        </Txt>
      ) : null}
      <TextInput placeholderTextColor={k.mute} {...props} style={[l.field, props.style]} />
    </View>
  );
}

/* ---------- sheets ---------- */

/**
 * A bottom sheet over the screen it came from (its route is a transparent
 * modal): the shade closes it, a grab bar on top, a title.
 */
export function Sheet({
  children,
  title,
  onClose,
}: {
  children: ReactNode;
  title?: string;
  onClose?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const close = onClose ?? (() => router.back());
  const y = useState(() => new Animated.Value(600))[0];
  useEffect(() => {
    Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220 }).start();
  }, [y]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.6)" }]}
        onPress={close}
        accessibilityLabel="Close"
      />
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: "flex-end" }}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[l.sheet, { paddingBottom: 34 + insets.bottom, transform: [{ translateY: y }] }]}
        >
          <View style={l.grab} />
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {title ? (
              <Txt
                display
                w="700"
                size={28}
                style={{ letterSpacing: -0.56, marginTop: 4, marginBottom: 14 }}
              >
                {title}
              </Txt>
            ) : null}
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

/* ---------- toast ---------- */

let toastText: { text: string; at: number } | null = null;
/** The last toast's text, kept while it fades out. */
let toastLast = "";
const toastSubs = new Set<() => void>();
const emit = () => {
  for (const f of toastSubs) f();
};

/** A short note at the bottom, gone in a moment. */
export function toast(text: string) {
  toastText = { text, at: Date.now() };
  toastLast = text;
  emit();
  const mine = toastText;
  setTimeout(() => {
    if (toastText === mine) {
      toastText = null;
      emit();
    }
  }, 1900);
}

/** Where toasts show (once, in the root layout). */
export function Toaster() {
  const t = useSyncExternalStore(
    (cb) => {
      toastSubs.add(cb);
      return () => toastSubs.delete(cb);
    },
    () => toastText,
  );
  const insets = useSafeAreaInsets();
  const o = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    Animated.timing(o, {
      toValue: t ? 1 : 0,
      duration: t ? 150 : 300,
      useNativeDriver: true,
    }).start();
  }, [t, o]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[l.toastWrap, { bottom: 104 + insets.bottom, opacity: o }]}
    >
      {toastLast ? (
        <View style={l.toast}>
          <Txt w="600" size={14} color={k.ink}>
            {toastLast}
          </Txt>
        </View>
      ) : null}
    </Animated.View>
  );
}

/* ---------- styles ---------- */

export const l = StyleSheet.create({
  page: { flex: 1, backgroundColor: k.ink },
  titleRow: { flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 18 },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 2,
    marginBottom: 14,
    minHeight: 32,
  },
  navSide: { minWidth: 72 },
  panel: { backgroundColor: k.ink2, borderWidth: 1, borderColor: k.line, borderRadius: r.m },
  hair: { height: 1, backgroundColor: k.line },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    minHeight: 56,
  },
  glyph: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: k.line2 },
  pill: { borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13, borderWidth: 1 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
  },
  toggle: { width: 50, height: 30, borderRadius: 999 },
  field: {
    backgroundColor: k.ink2,
    color: k.text,
    fontFamily: font.body,
    borderRadius: r.s,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: k.line2,
  },
  knob: {
    position: "absolute",
    top: 3,
    width: 24,
    height: 24,
    borderRadius: 99,
    backgroundColor: k.text,
  },
  sheet: {
    backgroundColor: k.ink2,
    borderTopWidth: 1,
    borderColor: k.line2,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingTop: 10,
    paddingHorizontal: 20,
    maxHeight: "88%",
  },
  grab: {
    width: 40,
    height: 5,
    borderRadius: 99,
    backgroundColor: k.line2,
    alignSelf: "center",
    marginBottom: 14,
  },
  toastWrap: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 40 },
  toast: { backgroundColor: k.text, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999 },
});
