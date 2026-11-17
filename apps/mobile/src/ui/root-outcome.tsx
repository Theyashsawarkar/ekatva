/** How a finished root request ended (from dvarapala's log, and who answered). */
import type { RootHistoryEntry } from "@ekatva/protocol";
import { View } from "react-native";
import type { IconName } from "./icon";
import { Glyph, Item, List, Txt } from "./lac";
import { k } from "./theme";

/** Its look: an icon, a colour and a title, by how it ended. */
export function lookOf(h: RootHistoryEntry): { icon: IconName; color: string; title: string } {
  const ran = h.commands.filter((x) => x.state === "ok" || x.state === "failed");
  const failed = h.commands.some((x) => x.state === "failed");
  if (h.status === "completed" && !failed)
    return {
      icon: "check",
      color: k.sage,
      title: `Ran ${ran.length} command${ran.length === 1 ? "" : "s"}`,
    };
  if (h.status === "completed") return { icon: "warn", color: k.rose, title: "A command failed" };
  if (h.status === "denied") return { icon: "stop", color: k.mute, title: "Denied" };
  if (h.status === "timeout") return { icon: "moon", color: k.amber, title: "Expired, unanswered" };
  if (h.status === "auth_failed")
    return { icon: "key", color: k.rose, title: "Wrong password 3 times" };
  return { icon: "warn", color: k.rose, title: h.status };
}

/** Who answered, in words. */
export const answeredBy = (h: RootHistoryEntry) =>
  h.where === "phone" ? "answered here" : "answered on the laptop";

/** How a request ended: who answered, what ran, each command's exit code. */
export function Outcome({ h }: { h: RootHistoryEntry }) {
  const look = lookOf(h);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Glyph name={look.icon} color={look.color} size={42} radius={13} />
        <View style={{ flex: 1 }}>
          <Txt display w="700" size={22} style={{ letterSpacing: -0.4 }}>
            {look.title}
          </Txt>
          <Txt size={13} color={k.sub} style={{ marginTop: 2 }}>
            For {h.requester}, {answeredBy(h)}
          </Txt>
        </View>
      </View>
      <List>
        {h.commands.map((x, i) => (
          <Item
            // biome-ignore lint/suspicious/noArrayIndexKey: the commands keep their order
            key={i}
            glyph={x.state === "ok" ? "check" : x.state === "failed" ? "close" : "stop"}
            glyphColor={x.state === "ok" ? k.sage : x.state === "failed" ? k.rose : k.mute}
            title={
              <Txt mono size={12.5} color={x.state === "failed" ? k.rose : k.text} lines={2}>
                {x.cmd}
              </Txt>
            }
            sub={
              x.state === "ok" || x.state === "failed"
                ? `Exit ${x.exitCode ?? "?"}`
                : x.decision === "declined"
                  ? "Not chosen"
                  : "Not run"
            }
          />
        ))}
      </List>
    </View>
  );
}
