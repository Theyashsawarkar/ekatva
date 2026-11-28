import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppRequests } from "../ui/app-requests";
import { ErrorBoundary } from "../ui/error-boundary";
import { Toaster } from "../ui/lac";
import { RingBanner } from "../ui/ring-banner";
import { AppProvider, useApp } from "../ui/state";
import { k } from "../ui/theme";
import Unlock from "./unlock";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Sheets: a transparent modal over the screen they came from (ui/lac Sheet draws them). */
const sheet = {
  presentation: "transparentModal",
  animation: "fade",
  contentStyle: { backgroundColor: "transparent" },
} as const;

// The fonts are built into the app (the expo-font plugin in app.json): nothing to wait for.
// The splash goes as soon as the first frame is laid out.
const hide = () => void SplashScreen.hideAsync().catch(() => undefined);

export default function Root() {
  // And never later than this, even if the first screen fails (the error boundary shows instead).
  useEffect(() => {
    const t = setTimeout(hide, 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: k.ink }} onLayout={hide}>
        <SafeAreaProvider>
          <AppProvider>
            <StatusBar style="light" />
            <Routes />
            <AppRequests />
            <RingBanner />
            <Toaster />
          </AppProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

/**
 * The screens, guarded by where the app is (never by redirects inside screens,
 * which bounced between each other forever when the app came back locked):
 * setup and the first unlock are routes; everything else needs an open session.
 * Locked again after a while away, the lock is a layer over the app, so
 * nothing navigates and you're back where you were.
 */
function Routes() {
  const { phase } = useApp();
  const open = phase === "ready" || phase === "locked";
  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: k.ink },
          animation: "fade",
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Protected guard={phase === "setup"} redirectTo="/">
          <Stack.Screen name="setup" />
        </Stack.Protected>
        <Stack.Protected guard={phase === "password"} redirectTo="/">
          <Stack.Screen name="unlock" />
        </Stack.Protected>
        <Stack.Protected guard={open} redirectTo="/">
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="pair"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen name="new-session" options={sheet} />
          <Stack.Screen name="agent/[id]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="file" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="root/[id]" options={sheet} />
          <Stack.Screen name="laptop-unlock" options={sheet} />
          <Stack.Screen name="trackpad" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="root-history" options={sheet} />
          <Stack.Screen name="notifications" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="permissions" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="apps" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="terminal" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="clipboard" options={sheet} />
          <Stack.Screen name="send" options={sheet} />
        </Stack.Protected>
      </Stack>
      {phase === "locked" ? <LockLayer /> : null}
    </>
  );
}

/** The lock over the app: Back does nothing while it's up. */
function LockLayer() {
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 50, backgroundColor: k.ink }]}>
      <Unlock />
    </View>
  );
}
