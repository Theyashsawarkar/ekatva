import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../ui/icon";
import { useIncomingShare } from "../../ui/incoming-share";
import { useApp, useLink, useWatch, watchOf } from "../../ui/state";
import { k } from "../../ui/theme";

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

const ICON: Record<string, IconName> = {
  index: "home",
  agents: "agents",
  files: "files",
  settings: "settings",
};

/** Four places: Home (the controls), Agents, Files, Settings. The action log lives under Settings. */
export default function TabsLayout() {
  const { phase, session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  useIncomingShare(phase === "ready");
  // The Agents tab carries a dot while an agent or root asks for you.
  // Pushed by the laptop (shared with Home and Agents), polled only as a safety net.
  const agents = useWatch(
    "agents.list",
    () => client?.agents.list.query() ?? null,
    watchOf(client?.agents.watch.subscribe),
    [client],
  );
  const roots = useWatch(
    "root.pending",
    () => client?.root.pending.query().catch(() => []) ?? null,
    watchOf(client?.root.watch.subscribe),
    [client],
  );
  const needs = (agents.data ?? []).filter((a) => a.question).length + (roots.data?.length ?? 0);
  return (
    <Tabs
      // Tabs you aren't on stop rendering (their polls stop too: usePoll asks only in focus).
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: k.ink },
        freezeOnBlur: true,
      }}
      tabBar={(props) => <TabBar {...props} badge={needs > 0} />}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="agents" options={{ title: "Agents" }} />
      <Tabs.Screen name="files" options={{ title: "Files" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
      <Tabs.Screen name="log" options={{ href: null, title: "Action log" }} />
    </Tabs>
  );
}

/** A floating pill, icons only; where you are is brass on plum. */
function TabBar({
  state,
  navigateToTab,
  descriptors,
  badge,
}: BottomTabBarProps & { badge: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: insets.bottom + 14,
        alignItems: "center",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          gap: 6,
          padding: 6,
          borderRadius: 999,
          backgroundColor: "rgba(32,26,38,0.96)",
          borderWidth: 1,
          borderColor: k.line2,
          elevation: 14,
          shadowColor: "#000",
          shadowOpacity: 0.6,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 18 },
        }}
      >
        {state.routes.map((route, i) => {
          const name = ICON[route.name];
          if (!name) return null;
          const on = state.index === i;
          const title = descriptors[route.key]?.options.title ?? route.name;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={
                route.name === "agents" && badge ? `${title}, something asks you` : title
              }
              onPress={() => {
                if (!on) navigateToTab(route.key);
              }}
              style={{
                width: 54,
                height: 48,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: on ? k.plum2 : "transparent",
              }}
            >
              <Icon name={name} size={23} color={on ? k.brass2 : k.mute} />
              {route.name === "agents" && badge ? (
                <View
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 10,
                    width: 12,
                    height: 12,
                    borderRadius: 99,
                    backgroundColor: k.amber,
                    borderWidth: 2,
                    borderColor: "#201a26",
                  }}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
