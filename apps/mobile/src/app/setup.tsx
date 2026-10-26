import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { strength } from "../core/vault";
import { Button, Card, Field, Screen, T } from "../ui/kit";
import { useApp } from "../ui/state";
import { c } from "../ui/theme";

const LABEL = ["too weak", "weak", "fair", "strong", "very strong"];
const COLOR = [c.red, c.red, c.gold, c.teal, c.teal];

/** First run: an app password, then the fingerprint (the keystore asks). */
export default function Setup() {
  const app = useApp();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = strength(pw);
  const ok = st.score >= 3 && pw === again;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.create(pw);
      router.replace("/(tabs)");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: 6, marginTop: 40, marginBottom: 12 }}>
        <T size={34} weight="800">
          ekatva
        </T>
        <T size={16} color={c.dim}>
          Your phone and your laptop as one device.
        </T>
      </View>
      <Card>
        <T weight="700" size={16}>
          Protect the app
        </T>
        <T color={c.dim}>
          ekatva can reach your laptop's files, agents and more, so it opens only with a strong
          password and your fingerprint. The password never leaves this phone, and there's no way to
          recover it: forgetting it means pairing again.
        </T>
        <Field
          label="App password"
          secureTextEntry
          value={pw}
          onChangeText={setPw}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="At least 10 characters"
        />
        {pw ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", gap: 4 }}>
              {[0, 1, 2, 3].map((i) => (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: i < Math.max(1, st.score) ? COLOR[st.score] : c.muted,
                  }}
                />
              ))}
            </View>
            <T size={12} color={COLOR[st.score]}>
              {LABEL[st.score]}
              {st.hint ? `: ${st.hint}` : ""}
            </T>
          </View>
        ) : null}
        <Field
          label="Again"
          secureTextEntry
          value={again}
          onChangeText={setAgain}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {again && pw !== again ? (
          <T size={12} color={c.red}>
            The two don't match.
          </T>
        ) : null}
        {error ? <T color={c.red}>{error}</T> : null}
        <Button
          label="Set up"
          kind="primary"
          icon="finger-print"
          onPress={go}
          busy={busy}
          disabled={!ok}
        />
      </Card>
    </Screen>
  );
}
