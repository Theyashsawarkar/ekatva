import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { useApp } from "../../ui/state";
import { c } from "../../ui/theme";

export default function TabsLayout() {
  const { phase } = useApp();
  if (phase !== "ready") return <Redirect href="/" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.crust,
          borderTopColor: c.line,
          height: 64,
          paddingTop: 6,
        },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.subtle,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        sceneStyle: { backgroundColor: c.base },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <Ionicons name="home" size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="agents"
        options={{
          title: "Agents",
          tabBarIcon: ({ color }) => <Ionicons name="sparkles" size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="files"
        options={{
          title: "Files",
          tabBarIcon: ({ color }) => (
            <Ionicons name="folder-open" size={22} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="log"
        options={{
          title: "Log",
          tabBarIcon: ({ color }) => <Ionicons name="list" size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <Ionicons name="settings" size={22} color={color as string} />,
        }}
      />
    </Tabs>
  );
}
