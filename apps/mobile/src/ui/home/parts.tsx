/**
 * Home's shared pieces: the tile surface, the "asks you" rows, the round
 * tools. Measured to the prototype (.tile, .asks, .tools).
 */
import type { LaptopRouter } from "@ekatva/protocol";
import type { TRPCClient } from "@trpc/client";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { Icon, type IconName } from "../icon";
import { Pill, Txt } from "../lac";
import { k } from "../theme";

export type Client = TRPCClient<LaptopRouter>;

/** Colours mixed into ink2 at a share (CSS color-mix), as #rrggbb. */
export function mix(hex: string, share: number, base = k.ink2): string {
  const p = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const a = p(hex);
  const b = p(base);
  return `#${a
    .map((v, i) => Math.round((b[i] as number) * (1 - share) + v * share))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** A row that asks for you: a glowing dot, what and who, one button. Amber an agent, rose root. */
export function AsksRow({
  tone,
  title,
  sub,
  action,
  onPress,
}: {
  tone: "amber" | "rose";
  title: string;
  sub: string;
  action: string;
  onPress: () => void;
}) {
  const color = tone === "amber" ? k.amber : k.rose;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}. ${action}`}
      style={({ pressed }) => [
        h.asks,
        {
          borderColor: `${color}73`,
          backgroundColor: mix(color, tone === "amber" ? 0.09 : 0.08),
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={h.dotBox}>
        <View style={[h.dotRing, { backgroundColor: `${color}38` }]} />
        <View style={[h.dot, { backgroundColor: color }]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt w="600" size={14.5} lines={1}>
          {title}
        </Txt>
        <Txt size={13} color={k.sub} lines={1}>
          {sub}
        </Txt>
      </View>
      <Pill label={action} tone={tone} onPress={onPress} />
    </Pressable>
  );
}

export interface ToolItem {
  icon: IconName;
  label: string;
  /** Wide tiles only: a line under the name. */
  sub?: string;
  color?: string;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * The tools, on the control grid: the first two as wide tiles (an icon in a
 * plum square, the name and a line), the rest as square tiles four across.
 */
export function Tools({ wide, small }: { wide: ToolItem[]; small: ToolItem[] }) {
  const press = (t: ToolItem) => ({
    onPress: t.onPress,
    disabled: t.disabled,
    accessibilityRole: "button" as const,
    accessibilityLabel: t.sub ? `${t.label}, ${t.sub}` : t.label,
  });
  return (
    <View style={{ marginTop: 12, gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        {wide.map((t) => (
          <Pressable key={t.label} {...press(t)} style={{ flex: 1, opacity: t.disabled ? 0.4 : 1 }}>
            {({ pressed }) => (
              <View style={[h.tile, h.wide, pressed ? { backgroundColor: k.plum } : null]}>
                <View style={h.wideIcon}>
                  <Icon name={t.icon} size={22} color={t.color ?? k.brass2} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt w="600" size={15} lines={1}>
                    {t.label}
                  </Txt>
                  {t.sub ? (
                    <Txt size={12} color={k.sub} lines={1} style={{ marginTop: 2 }}>
                      {t.sub}
                    </Txt>
                  ) : null}
                </View>
              </View>
            )}
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        {small.map((t) => (
          <Pressable key={t.label} {...press(t)} style={{ flex: 1, opacity: t.disabled ? 0.4 : 1 }}>
            {({ pressed }) => (
              <View style={[h.tile, h.square, pressed ? { backgroundColor: k.plum } : null]}>
                <Icon name={t.icon} size={22} color={t.color ?? k.brass2} />
                <Txt w="500" size={12} color={k.sub} lines={1}>
                  {t.label}
                </Txt>
              </View>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A tile of the control grid. */
export function Tile({ children, style, ...rest }: ViewProps & { children?: ReactNode }) {
  return (
    <View {...rest} style={[h.tile, style]}>
      {children}
    </View>
  );
}

export const h = StyleSheet.create({
  tile: {
    backgroundColor: k.ink2,
    borderWidth: 1,
    borderColor: k.line,
    borderRadius: 26,
    overflow: "hidden",
  },
  asks: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 10,
  },
  dotBox: { width: 9, height: 9, alignItems: "center", justifyContent: "center" },
  dotRing: { position: "absolute", width: 17, height: 17, borderRadius: 99 },
  dot: { width: 9, height: 9, borderRadius: 99 },
  wide: { height: 78, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  wideIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: k.plum,
    alignItems: "center",
    justifyContent: "center",
  },
  square: { height: 78, alignItems: "center", justifyContent: "center", gap: 7 },
});
