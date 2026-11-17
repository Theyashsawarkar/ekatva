/**
 * If a screen throws, the app shows this instead of a blank (gray) window:
 * what happened in a sentence and a way back. The error goes to logcat,
 * tagged [ekatva], for finding out why.
 */
import { Component, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { errorText } from "./errors";
import { k } from "./theme";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; attempt: number }
> {
  state = { error: null as unknown, attempt: 0 };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error(
      `[ekatva] a screen failed: ${errorText(error)}\n${(info.componentStack ?? "").slice(0, 2000)}`,
    );
  }

  render() {
    if (this.state.error === null)
      return (
        <View key={this.state.attempt} style={{ flex: 1 }}>
          {this.props.children}
        </View>
      );
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: k.ink,
          alignItems: "center",
          justifyContent: "center",
          padding: 28,
          gap: 12,
        }}
      >
        <Text style={{ color: k.text, fontSize: 26, fontWeight: "700", textAlign: "center" }}>
          Something went wrong
        </Text>
        <Text style={{ color: k.sub, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
          {errorText(this.state.error)}
        </Text>
        <Pressable
          onPress={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
          accessibilityRole="button"
          style={({ pressed }) => ({
            marginTop: 10,
            backgroundColor: k.text,
            borderRadius: 14,
            paddingVertical: 13,
            paddingHorizontal: 28,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ color: k.ink, fontSize: 15, fontWeight: "600" }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
