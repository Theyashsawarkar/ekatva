/**
 * Whether decorative motion may run now: the screen is in front (its tab or
 * stack screen is focused), the app is in front, and the system's "remove
 * animations" setting is off. Loops (steam, stars, waves, the record, the
 * agents' spinners) stop otherwise and show a still frame, so nothing ticks
 * at 60–120 Hz behind another tab or with the screen off.
 */
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}

export function useMotion(): boolean {
  const focused = useIsFocused();
  const active = useAppActive();
  const reduced = useReducedMotion();
  return focused && active && !reduced;
}
