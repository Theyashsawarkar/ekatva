/**
 * The bell at the top of Home: the laptop's notifications. A brass count
 * shows how many came since you last looked (brass: where you are, not an
 * alarm); none, just the bell. Only when this phone may see them.
 */
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import type { Client } from "../home/parts";
import { Icon } from "../icon";
import { Txt } from "../lac";
import { usePoll } from "../state";
import { k } from "../theme";
import { useSeen } from "./seen";

export function LaptopBell({ client }: { client: Client | null }) {
  const notes = usePoll(
    () => client?.notifications.history.query().catch(() => null) ?? null,
    [client],
    30_000,
    { key: "notifications.history" },
  );
  const seen = useSeen();
  if (!client || !notes.data) return null;
  const fresh = notes.data.items.filter((x) => x.at > seen).length;
  const label = fresh ? `Laptop notifications, ${fresh} new` : "Laptop notifications";
  return (
    <Pressable
      onPress={() => router.push("/notifications")}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? k.plum : k.ink2,
        borderWidth: 1,
        borderColor: fresh ? `${k.brass}66` : k.line2,
        marginBottom: 4,
      })}
    >
      <Icon name="bell" size={20} color={fresh ? k.brass2 : k.sub} />
      {fresh ? (
        <View
          style={{
            position: "absolute",
            top: -3,
            right: -3,
            minWidth: 19,
            height: 19,
            paddingHorizontal: 5,
            borderRadius: 10,
            backgroundColor: k.brass2,
            borderWidth: 2,
            borderColor: k.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Txt mono w="600" size={10.5} color={k.ink}>
            {fresh > 9 ? "9+" : String(fresh)}
          </Txt>
        </View>
      ) : null}
    </Pressable>
  );
}
