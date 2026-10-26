/** The few building blocks every screen uses. */
import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { c, font, r } from "./theme";

export type Icon = ComponentProps<typeof Ionicons>["name"];

export function Screen({
  title,
  right,
  children,
  scroll = true,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}) {
  const body = scroll ? (
    <ScrollView contentContainerStyle={s.body}>{children}</ScrollView>
  ) : (
    <View style={[s.body, { flex: 1 }]}>{children}</View>
  );
  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      {title ? (
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          <View style={{ flex: 1 }} />
          {right}
        </View>
      ) : null}
      {body}
    </SafeAreaView>
  );
}

export function Card({
  children,
  tone,
  style,
}: {
  children: ReactNode;
  tone?: "gold" | "accent" | "red";
  style?: ViewStyle;
}) {
  const toneStyle = tone ? { borderColor: `${c[tone]}80`, backgroundColor: `${c[tone]}12` } : null;
  return <View style={[s.card, toneStyle, style]}>{children}</View>;
}

export function T({
  children,
  size = 14,
  color = c.text,
  weight,
  mono,
  style,
  lines,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  weight?: "400" | "500" | "600" | "700" | "800";
  mono?: boolean;
  style?: object;
  lines?: number;
}) {
  return (
    <Text
      numberOfLines={lines}
      style={[
        {
          color,
          fontSize: size,
          fontWeight: weight ?? "400",
          fontFamily: mono ? font.mono : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  kind = "plain",
  icon,
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger" | "teal";
  icon?: Icon;
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const bg = {
    primary: c.accent,
    plain: "rgba(255,255,255,0.08)",
    danger: `${c.red}2e`,
    teal: `${c.teal}2e`,
  }[kind];
  const fg = { primary: c.crust, plain: c.text, danger: c.red, teal: c.teal }[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <Ionicons name={icon} size={17} color={fg} />
      ) : null}
      <Text style={{ color: fg, fontWeight: "700", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  label,
  tone = "plain",
}: {
  label: string;
  tone?: "plain" | "ok" | "warn" | "accent" | "bad";
}) {
  const color = { plain: c.sub, ok: c.teal, warn: c.gold, accent: c.accent, bad: c.red }[tone];
  return (
    <View
      style={[
        s.chip,
        { backgroundColor: tone === "plain" ? "rgba(255,255,255,0.06)" : `${color}24` },
      ]}
    >
      <Text style={{ color, fontSize: 11.5, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Row({
  icon,
  title,
  detail,
  right,
  onPress,
  onLongPress,
}: {
  icon?: Icon;
  title: string;
  detail?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        s.row,
        pressed && onPress ? { backgroundColor: "rgba(255,255,255,0.04)" } : null,
      ]}
    >
      {icon ? <Ionicons name={icon} size={20} color={c.dim} style={{ width: 26 }} /> : null}
      <View style={{ flex: 1 }}>
        <T weight="600" lines={1}>
          {title}
        </T>
        {detail ? (
          <T size={12} color={c.subtle} lines={2}>
            {detail}
          </T>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  return (
    <View style={{ gap: 6 }}>
      {props.label ? (
        <T size={12} color={c.dim} weight="600">
          {props.label}
        </T>
      ) : null}
      <TextInput placeholderTextColor={c.subtle} {...props} style={[s.field, props.style]} />
    </View>
  );
}

export function Empty({
  icon,
  title,
  detail,
  action,
}: {
  icon: Icon;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", gap: 10, paddingVertical: 48, paddingHorizontal: 24 }}>
      <Ionicons name={icon} size={40} color={c.muted} />
      <T size={16} weight="700">
        {title}
      </T>
      {detail ? (
        <T color={c.dim} style={{ textAlign: "center" }}>
          {detail}
        </T>
      ) : null}
      {action}
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.base },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 8,
  },
  title: { color: c.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  body: { padding: 14, gap: 10, paddingBottom: 40 },
  card: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: r.m,
    padding: 14,
    gap: 8,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: r.s + 2,
  },
  chip: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 8, alignSelf: "flex-start" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: r.s,
  },
  field: {
    backgroundColor: c.overlay,
    color: c.text,
    borderRadius: r.s,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: c.line,
  },
  mono: { fontFamily: font.mono, fontSize: 11.5, color: c.sub, lineHeight: 16 },
});
