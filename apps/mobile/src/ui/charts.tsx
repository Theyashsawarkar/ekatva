/** Small live drawings: a ring gauge and a sparkline. */
import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { c } from "./theme";

/** A ring filled to `value` (0–100), with what's inside it. */
export function Gauge({
  value,
  color = c.green,
  size = 80,
  stroke = 8,
  children,
}: {
  value: number;
  color?: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: color,
        shadowOpacity: 0.55,
        shadowRadius: 14,
      }}
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(len * v) / 100} ${len}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

/** Recent values as a line with a soft fill under it (0–100). */
export function Sparkline({
  values,
  color = c.teal,
  height = 22,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  const w = 100;
  const pts = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const step = w / (pts.length - 1);
  const y = (v: number) => height - 2 - (Math.max(0, Math.min(100, v)) / 100) * (height - 4);
  const line = pts
    .map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.55" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Path d={`${line} L${w} ${height} L0 ${height} Z`} fill="url(#spark)" />
      <Path d={line} stroke={color} strokeWidth={2} fill="none" />
    </Svg>
  );
}
