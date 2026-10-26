import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";
import { Button, Card, Screen, T } from "../ui/kit";
import { useApp } from "../ui/state";
import { c } from "../ui/theme";

/** Scan the laptop's QR code; compare the emoji; confirm on the laptop. */
export default function Pair() {
  const { session } = useApp();
  const [permission, ask] = useCameraPermissions();
  const [emoji, setEmoji] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busy = useRef(false);

  const scanned = async (data: string) => {
    if (busy.current || !session || !data.startsWith("ekatva://pair")) return;
    busy.current = true;
    setError(null);
    try {
      const laptop = await session.link.pair(data, setEmoji);
      setDone(laptop.name);
      setTimeout(() => router.back(), 1200);
    } catch (e) {
      setError((e as Error).message);
      setEmoji(null);
      busy.current = false;
    }
  };

  return (
    <Screen
      title="Pair with a laptop"
      right={<Button label="Close" onPress={() => router.back()} />}
    >
      {!permission?.granted ? (
        <Card>
          <T>
            The camera reads the QR code your laptop shows (`ekatva pair`, or the desktop window).
          </T>
          <Button
            label="Allow the camera"
            kind="primary"
            icon="camera"
            onPress={() => void ask()}
          />
        </Card>
      ) : emoji ? (
        <Card tone="accent" style={{ alignItems: "center", paddingVertical: 28 }}>
          <T size={44} style={{ letterSpacing: 10 }}>
            {emoji.join(" ")}
          </T>
          <T weight="700" size={16} style={{ textAlign: "center" }}>
            {done ? `Paired with ${done}` : "Does your laptop show the same four?"}
          </T>
          <T color={c.dim} style={{ textAlign: "center" }}>
            {done
              ? ""
              : "If they match, confirm on the laptop. If they don't, refuse there: someone else may have used the code."}
          </T>
        </Card>
      ) : (
        <View
          style={{ borderRadius: 22, overflow: "hidden", height: 380, backgroundColor: "#000" }}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(r) => void scanned(r.data)}
          />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 70,
              left: 50,
              right: 50,
              bottom: 70,
              borderWidth: 3,
              borderColor: c.teal,
              borderRadius: 18,
            }}
          />
        </View>
      )}
      {error ? (
        <Card tone="red">
          <T color={c.red}>{error}</T>
        </Card>
      ) : null}
      <T size={12} color={c.subtle}>
        The code works once, for two minutes. Nothing in it is a lasting secret.
      </T>
    </Screen>
  );
}
