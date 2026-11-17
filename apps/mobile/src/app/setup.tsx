import { useState } from "react";
import { Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Brand, LockGlow, Shloka } from "../ui/brand";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Txt } from "../ui/lac";
import { useApp } from "../ui/state";
import { k } from "../ui/theme";

/** First run: this phone's keys, kept behind your fingerprint (the keystore asks). */
export default function Setup() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    await app
      .create()
      .catch((e: unknown) => setError(/cancel/i.test(errorText(e)) ? null : errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }}>
      <LockGlow />
      <View style={{ flex: 1, paddingHorizontal: 30, justifyContent: "space-between" }}>
        <View style={{ marginTop: 74 }}>
          <Brand />
        </View>
        <View style={{ alignItems: "center" }}>
          <Txt
            size={13.5}
            color={k.sub}
            align="center"
            style={{ lineHeight: 21, marginBottom: 22 }}
          >
            ekatva can reach your laptop's files, agents and more, so it opens only with your
            fingerprint (or your phone's screen lock). Its keys never leave this phone's secure
            hardware.
          </Txt>
          <Pressable
            onPress={() => void go()}
            disabled={busy}
            style={({ pressed }) => ({
              width: 84,
              height: 84,
              borderRadius: 99,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: k.line2,
              backgroundColor: pressed ? k.plum : "transparent",
              marginBottom: 14,
            })}
            accessibilityRole="button"
            accessibilityLabel="Set up with your fingerprint"
          >
            <Icon name="finger" size={40} color={k.brass2} />
          </Pressable>
          <Txt size={13} color={k.sub}>
            {busy ? "Waiting for your fingerprint…" : "Touch to set up"}
          </Txt>
          <Txt size={12.5} color={k.mute} style={{ marginTop: 4 }}>
            or use your phone's PIN
          </Txt>
          {error ? (
            <Txt size={13} color={k.rose} align="center" style={{ marginTop: 12 }}>
              {error}
            </Txt>
          ) : null}
        </View>
        <View style={{ marginBottom: 40 }}>
          <Shloka />
        </View>
      </View>
    </SafeAreaView>
  );
}
