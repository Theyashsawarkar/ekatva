/**
 * The app's own line icons (the prototype's symbols, one stroke weight):
 * 24×24, stroked in the given colour, no fill.
 */
import type { ReactNode } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { k } from "./theme";

const P = (d: string) => <Path d={d} />;

const ICONS = {
  home: P("M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"),
  agents: (
    <>
      <Circle cx={12} cy={8} r={3.5} />
      {P("M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5")}
      {P("M19 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z")}
    </>
  ),
  files: P(
    "M3.5 7.5A1.5 1.5 0 0 1 5 6h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
  ),
  settings: (
    <>
      {P("M4 7h10M18 7h2M4 17h4M12 17h8")}
      <Circle cx={16} cy={7} r={2} />
      <Circle cx={10} cy={17} r={2} />
    </>
  ),
  chev: P("m9 6 6 6-6 6"),
  back: P("m15 6-6 6 6 6"),
  wifi: (
    <>
      {P("M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0")}
      <Circle cx={12} cy={19.5} r={0.6} />
    </>
  ),
  globe: (
    <>
      <Circle cx={12} cy={12} r={8.5} />
      {P(
        "M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z",
      )}
    </>
  ),
  offline: P(
    "M5 12.5a10 10 0 0 1 4.2-2.4M14.5 10a10 10 0 0 1 4.5 2.5M8.5 16a5 5 0 0 1 7 0M3 3l18 18",
  ),
  lock: (
    <>
      <Rect x={5} y={11} width={14} height={9} rx={2.5} />
      {P("M8.5 11V8a3.5 3.5 0 0 1 7 0v3")}
    </>
  ),
  cpu: (
    <>
      <Rect x={7} y={7} width={10} height={10} rx={2} />
      {P("M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4")}
    </>
  ),
  temp: P("M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"),
  bolt: P("M13 3 5 13.5h6L10 21l8-10.5h-6z"),
  vol: P("M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"),
  mute: P("M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5"),
  sun: (
    <>
      <Circle cx={12} cy={12} r={4} />
      {P(
        "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
      )}
    </>
  ),
  play: P("M8 5.5v13l10.5-6.5z"),
  pause: P("M8.5 5.5v13M15.5 5.5v13"),
  next: P("M6 6v12l8.5-6zM17.5 6v12"),
  rew: P("M11.5 6.5 5 12l6.5 5.5zM19.5 6.5 13 12l6.5 5.5z"),
  fwd: P("M12.5 6.5 19 12l-6.5 5.5zM4.5 6.5 11 12l-6.5 5.5z"),
  prev: P("M18 6v12l-8.5-6zM6.5 6v12"),
  pad: (
    <>
      <Rect x={4} y={3.5} width={16} height={17} rx={3} />
      {P("M4 14.5h16M12 14.5v6")}
    </>
  ),
  term: (
    <>
      <Rect x={3} y={4.5} width={18} height={15} rx={3} />
      {P("m7 9.5 3 2.5-3 2.5M12 15h5")}
    </>
  ),
  clip: (
    <>
      <Rect x={8.5} y={3} width={7} height={3.5} rx={1.2} />
      {P("M15.5 4.5h1.5A2 2 0 0 1 19 6.5v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h1.5")}
    </>
  ),
  send: P("M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"),
  moon: P("M19.5 14A8 8 0 0 1 10 4.5a8 8 0 1 0 9.5 9.5z"),
  // Jyoti's levels: Śānta, the diya unlit (a wisp of smoke); Akhaṇḍa, the
  // diya; Nandādīpa, the samai (the standing brass lamp). The same drawings
  // in the popup and the bar.
  shanta: (
    <>
      {P("M4 14.5h16a8 6 0 0 1-16 0zM9.5 22h5M12 14.4v-1.6")}
      <Path d="M12 10.9c-1.2-1 .9-2.1-.2-3.4s.9-2.2.1-3.5" opacity={0.75} />
    </>
  ),
  akhanda: P(
    "M4 14.5h16a8 6 0 0 1-16 0zM9.5 22h5M12 4.6c1.9 2.3 2.7 4 2.7 5.3a2.7 2.7 0 0 1-5.4 0c0-1.3.8-3 2.7-5.3zM12 9.2v1.2",
  ),
  nandadipa: (
    <>
      {P(
        "M5 11.2h14c-.6 1.7-3.4 2.6-7 2.6s-6.4-.9-7-2.6zM12 13.8v5M8.5 21.5h7l-1.2-2.7h-4.6zM12 4.04c1.52 1.84 2.16 3.2 2.16 4.24a2.16 2.16 0 0 1-4.32 0c0-1.04.64-2.4 2.16-4.24zM6.6 7.58c.8.97 1.13 1.68 1.13 2.23a1.13 1.13 0 0 1-2.27 0c0-.55.34-1.26 1.13-2.23zM17.4 7.58c.8.97 1.13 1.68 1.13 2.23a1.13 1.13 0 0 1-2.27 0c0-.55.34-1.26 1.13-2.23z",
      )}
      <Circle cx={12} cy={16} r={1.1} />
    </>
  ),
  ring: P("M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9M10 20.5a2.3 2.3 0 0 0 4 0"),
  spin: P("M20 12a8 8 0 1 1-5-7.4"),
  check: P("m5 12.5 4.5 4.5L19 7.5"),
  shield: P("M12 21s7.5-3.5 7.5-9.5V5.5L12 3 4.5 5.5v6C4.5 17.5 12 21 12 21z"),
  up: P("M12 19V5M6 11l6-6 6 6"),
  down: P("M12 5v14M6 13l6 6 6-6"),
  left: P("M19 12H5M11 6l-6 6 6 6"),
  right: P("M5 12h14M13 6l6 6-6 6"),
  stop: <Rect x={7} y={7} width={10} height={10} rx={2} />,
  finger: P(
    "M12 11v3.5a8 8 0 0 1-1 4M8 9.5a4 4 0 0 1 8 0V12c0 2-.3 4-1 6M5 11a7 7 0 0 1 14 0v1c0 1.6-.2 3.2-.6 4.7M6.4 6A9 9 0 0 1 17.6 6M8.6 20c.8-1.8 1.2-3.8 1.3-5.8",
  ),
  folder: P(
    "M3.5 7.5A1.5 1.5 0 0 1 5 6h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
  ),
  doc: (
    <>
      {P("M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z")}
      {P("M14 3.5V8h4.5")}
    </>
  ),
  image: (
    <>
      <Rect x={3.5} y={4.5} width={17} height={15} rx={2.5} />
      <Circle cx={9} cy={10} r={1.6} />
      {P("m20.5 16-5-5-9 8.5")}
    </>
  ),
  phone: (
    <>
      <Rect x={7} y={3} width={10} height={18} rx={2.5} />
      {P("M11 18h2")}
    </>
  ),
  laptop: (
    <>
      <Rect x={5} y={5} width={14} height={10} rx={1.5} />
      {P("M3 18.5h18")}
    </>
  ),
  list: P("M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"),
  bell: P("M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9M10 20.5a2.3 2.3 0 0 0 4 0"),
  chat: P("M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 20.5 12z"),
  plus: P("M12 5v14M5 12h14"),
  close: P("M6 6l12 12M18 6 6 18"),
  refresh: P("M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"),
  sync: P("M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"),
  search: (
    <>
      <Circle cx={11} cy={11} r={6.5} />
      {P("m20 20-4.2-4.2")}
    </>
  ),
  enter: P("M19 5v7a3 3 0 0 1-3 3H6M9.5 11.5 6 15l3.5 3.5"),
  more: (
    <>
      <Circle cx={6} cy={12} r={1} />
      <Circle cx={12} cy={12} r={1} />
      <Circle cx={18} cy={12} r={1} />
    </>
  ),
  backspace: P(
    "M9 5.5h10.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12zM11.5 9.5l5 5M16.5 9.5l-5 5",
  ),
  qr: (
    <>
      <Rect x={4} y={4} width={6} height={6} rx={1.2} />
      <Rect x={14} y={4} width={6} height={6} rx={1.2} />
      <Rect x={4} y={14} width={6} height={6} rx={1.2} />
      {P("M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2")}
    </>
  ),
  undo: P("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"),
  trash: P("M4.5 7h15M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5h6V7"),
  download: P("M12 4v11M7 10.5l5 5 5-5M5 19.5h14"),
  info: (
    <>
      <Circle cx={12} cy={12} r={8.5} />
      {P("M12 11v5.5M12 7.8v.01")}
    </>
  ),
  warn: P("M12 4 2.5 20h19zM12 10v4.5M12 17.3v.01"),
  key: (
    <>
      <Circle cx={8} cy={15} r={4} />
      {P("m11 12 8.5-8.5M16 6.5l2.5 2.5M14 8.5l2 2")}
    </>
  ),
  hand: P(
    "M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 15l-1-3a1.5 1.5 0 0 1 2.6-1.4L8 13",
  ),
  pencil: P("M15 5l4 4L8.5 19.5H4.5v-4zM13 7l4 4"),
  call: P(
    "M5 4.5h3l1.5 4-2 1.2a10 10 0 0 0 4.8 4.8l1.2-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5z",
  ),
  power: P("M12 3.5v8M7.2 6.5a7 7 0 1 0 9.6 0"),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  color = k.text,
  stroke = 1.7,
  fill = "none",
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
  fill?: string;
  style?: object;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill={fill}
      style={style}
    >
      {ICONS[name]}
    </Svg>
  );
}
