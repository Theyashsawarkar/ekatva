import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, Screen, T } from "../ui/kit";
import { useApp } from "../ui/state";
import { c } from "../ui/theme";

/** The password once per start (and the fingerprint); the fingerprint alone after a short lock. */
export default function Unlock() {
  const app = useApp();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quick = app.phase === "locked";

  useEffect(() => {
    if (app.phase === "ready") router.replace("/(tabs)");
  }, [app.phase]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (quick) await app.unlockWithFingerprint();
      else await app.unlock(pw);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Ask for the fingerprint once, on arrival, when that's all it takes.
  const asked = useRef(false);
  useEffect(() => {
    if (quick && !asked.current) {
      asked.current = true;
      void go();
    }
  });

  return (
    <Screen>
      <View style={{ gap: 6, marginTop: 60, marginBottom: 12 }}>
        <T size={34} weight="800">
          ekatva
        </T>
        <T size={16} color={c.dim}>
          {quick ? "Locked. Use your fingerprint." : "Your password, then your fingerprint."}
        </T>
      </View>
      <Card>
        {quick ? null : (
          <Field
            label="App password"
            secureTextEntry
            autoFocus
            value={pw}
            onChangeText={setPw}
            onSubmitEditing={go}
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {error ? <T color={c.red}>{error}</T> : null}
        <Button
          label="Unlock"
          kind="primary"
          icon="finger-print"
          onPress={go}
          busy={busy}
          disabled={!quick && pw.length < 1}
        />
      </Card>
    </Screen>
  );
}
