import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyGone, NeedsPassword } from "../core/vault";
import { Brand, LockGlow, Shloka } from "../ui/brand";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Btn, Field, Txt } from "../ui/lac";
import { useApp } from "../ui/state";
import { k } from "../ui/theme";

/**
 * Opening the app: the fingerprint, and that's all. A vault from before
 * (sealed with an app password too) asks for that password once, then it's
 * fingerprint-only for good.
 */
export default function Unlock() {
  const app = useApp();
  const quick = app.phase === "locked";
  const [step, setStep] = useState<"finger" | "password">("finger");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where to go after unlocking is the router's guards' job (app/_layout.tsx), not this screen's.

  const finger = async () => {
    setBusy(true);
    setError(null);
    await (quick ? app.unlockWithFingerprint() : app.unlock())
      .catch((e: unknown) => {
        if (e instanceof NeedsPassword) setStep("password");
        else if (e instanceof KeyGone) setError(e.message);
        else setError(/cancel/i.test(errorText(e)) ? null : errorText(e));
      })
      .finally(() => setBusy(false));
  };

  const password = async () => {
    if (!pw) return;
    setBusy(true);
    setError(null);
    await app
      .unlockWithPassword(pw)
      .catch((e: unknown) =>
        setError(
          (e as Error).message === "wrong password" ? "That's not the password." : errorText(e),
        ),
      )
      .finally(() => setBusy(false));
  };

  // Ask for the fingerprint as soon as the screen opens.
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) {
      asked.current = true;
      void finger();
    }
  });

  // When the keys can't be opened any more (fingerprints changed, an old password forgotten).
  const startOver = () =>
    Alert.alert(
      "Start over?",
      "This deletes this phone's ekatva: its key, its paired laptops and its action log. Then " +
        "you set it up with your fingerprint and pair again (on the laptop, `ekatva unpair` the " +
        "old one first). Nothing on the laptop is lost.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start over", style: "destructive", onPress: () => void app.reset() },
      ],
    );

  const fingerDone = step === "password" && !quick;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }}>
      <LockGlow />
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, paddingHorizontal: 30, justifyContent: "space-between" }}
      >
        <View style={{ marginTop: 74 }}>
          <Brand />
        </View>

        <View style={{ alignItems: "center" }}>
          {fingerDone ? (
            <View style={{ alignSelf: "stretch", gap: 14 }}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "center" }}
              >
                <StepDot n={1} label="Fingerprint" done on={false} />
                <View style={{ width: 28, height: 2, borderRadius: 1, backgroundColor: k.line2 }} />
                <StepDot n={2} label="Old password, once" done={false} on />
              </View>
              <Txt size={13} color={k.sub} align="center" style={{ lineHeight: 19 }}>
                ekatva doesn't use a password any more. Enter yours one last time, and from then on
                your fingerprint alone opens it.
              </Txt>
              <Field
                label="Old app password"
                secureTextEntry
                autoFocus
                value={pw}
                onChangeText={setPw}
                onSubmitEditing={password}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
              />
              <Btn
                label="Unlock, and drop the password"
                kind="solid"
                onPress={() => void password()}
                busy={busy}
                disabled={pw.length < 1}
                style={{ marginTop: 0 }}
              />
            </View>
          ) : (
            <>
              <Pressable
                onPress={() => void finger()}
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
                accessibilityLabel="Open with your fingerprint or your phone's PIN"
              >
                <Icon name="finger" size={40} color={k.brass2} />
              </Pressable>
              <Txt size={13} color={k.sub}>
                {busy ? "Waiting for your fingerprint…" : "Touch to open"}
              </Txt>
              <Txt size={12.5} color={k.mute} style={{ marginTop: 4 }}>
                or use your phone's PIN
              </Txt>
            </>
          )}
          {error ? (
            <Txt size={13} color={k.rose} align="center" style={{ marginTop: 12 }}>
              {error}
            </Txt>
          ) : null}
          {quick ? null : (
            <Pressable
              onPress={startOver}
              hitSlop={10}
              style={{ marginTop: 14 }}
              accessibilityRole="button"
            >
              <Txt size={12.5} color={k.mute}>
                {fingerDone ? "Forgot the password?" : "Can't open it?"}{" "}
                <Txt size={12.5} color={k.brass2}>
                  Start over
                </Txt>
              </Txt>
            </Pressable>
          )}
        </View>

        <View style={{ marginBottom: 40 }}>
          <Shloka />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StepDot({ n, label, done, on }: { n: number; label: string; done: boolean; on: boolean }) {
  const color = done ? k.sage : on ? k.brass2 : k.mute;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: color,
        }}
      >
        {done ? (
          <Icon name="check" size={14} color={color} />
        ) : (
          <Txt size={11} w="700" color={color}>
            {String(n)}
          </Txt>
        )}
      </View>
      <Txt size={13} w="600" color={color}>
        {label}
      </Txt>
    </View>
  );
}
