import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../ui/state";
import { c } from "../ui/theme";

export default function Root() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.base }}>
      <SafeAreaProvider>
        <AppProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: c.base },
              animation: "fade",
            }}
          >
            <Stack.Screen
              name="pair"
              options={{ presentation: "modal", animation: "slide_from_bottom" }}
            />
            <Stack.Screen
              name="new-session"
              options={{ presentation: "modal", animation: "slide_from_bottom" }}
            />
            <Stack.Screen name="agent/[id]" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="file" options={{ animation: "slide_from_right" }} />
          </Stack>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
