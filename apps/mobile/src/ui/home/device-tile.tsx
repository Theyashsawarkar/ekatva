/** The laptop at a glance: ekatva's mark, its battery big, CPU and heat, how it's reached. */
import type { Status } from "@ekatva/protocol";
import { View } from "react-native";
import { Logo } from "../brand";
import { Icon } from "../icon";
import { Txt } from "../lac";
import { k } from "../theme";
import { Tile } from "./parts";

export function DeviceTile({
  name,
  status,
  via,
}: {
  name: string;
  status: Status | null;
  via: "lan" | "tunnel" | null;
}) {
  const b = status?.battery ?? null;
  const plugged = !!b && (b.plugged ?? b.charging);
  const low = b ? b.percent <= 15 && !plugged : false;
  // Charging; plugged in but held (a charge limit, or full); or on battery.
  const line = b
    ? `${name}, ${b.charging ? "charging" : plugged ? "plugged in" : "on battery"}`
    : name;
  return (
    <Tile
      style={{ flex: 1, paddingVertical: 14, paddingHorizontal: 16 }}
      accessible
      accessibilityLabel={`${name}${b ? `, battery ${b.percent} percent${b.charging ? ", charging" : plugged ? ", plugged in" : ", on battery"}` : ""}, ${via === "lan" ? "connected directly" : via === "tunnel" ? "connected from away" : "not connected"}`}
    >
      <Logo size={30} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: 14 }}>
        <Txt display w="700" size={44} style={{ letterSpacing: -1.32, lineHeight: 46 }}>
          {b ? b.percent : "—"}
        </Txt>
        {b ? (
          <Txt display w="700" size={18} color={k.sub} style={{ marginLeft: 2, marginBottom: 6 }}>
            %
          </Txt>
        ) : null}
      </View>
      <Txt
        size={13}
        color={low ? k.rose : plugged ? k.sage : k.sub}
        lines={1}
        style={{ marginTop: 2 }}
      >
        {line}
      </Txt>
      <View style={{ flexDirection: "row", gap: 12, marginTop: 10 }}>
        <View style={stat}>
          <Icon name="cpu" size={14} color={k.sub} />
          <Txt size={12.5} color={k.sub}>
            {status?.cpu != null ? `${status.cpu}%` : "—"}
          </Txt>
        </View>
        <View style={stat}>
          <Icon name="temp" size={14} color={k.sub} />
          <Txt size={12.5} color={k.sub}>
            {status?.temperature != null ? `${status.temperature}°` : "—"}
          </Txt>
        </View>
      </View>
      {via ? (
        <View style={net}>
          <Icon name={via === "lan" ? "wifi" : "globe"} size={14} color={k.steel} />
          <Txt size={12.5} color={k.steel}>
            {via === "lan" ? "Direct" : "Away"}
          </Txt>
        </View>
      ) : null}
    </Tile>
  );
}

const stat = { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 };
const net = {
  position: "absolute" as const,
  right: 14,
  top: 14,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 5,
};
