import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useApp } from "../ui/state";
import { c } from "../ui/theme";

/** Where to go: set up, unlock, or in. */
export default function Gate() {
  const { phase } = useApp();
  if (phase === "loading") {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.base }}
      >
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  if (phase === "setup") return <Redirect href="/setup" />;
  if (phase === "password" || phase === "locked") return <Redirect href="/unlock" />;
  return <Redirect href="/(tabs)" />;
}
