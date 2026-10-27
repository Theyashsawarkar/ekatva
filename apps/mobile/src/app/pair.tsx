import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, useWindowDimensions, View } from "react-native";
import { Button, Card, Screen, T } from "../ui/kit";
import { useApp } from "../ui/state";
import { c, r } from "../ui/theme";

type Phase = "scan" | "connecting" | "failed";

/** Scan the laptop's QR code; compare the emoji; confirm on the laptop. */
export default function Pair() {
  const { session } = useApp();
  const [permission, ask] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>("scan");
  const [emoji, setEmoji] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busy = useRef(false);

  const scanned = async (data: string) => {
    if (busy.current || !session || !data.startsWith("ekatva://pair")) return;
    busy.current = true;
    setError(null);
    setPhase("connecting");
    try {
      const laptop = await session.link.pair(data, setEmoji);
      setDone(laptop.name);
      setTimeout(() => router.back(), 1200);
    } catch (e) {
      // Stop here: rescanning the same code would just fail again.
      setError((e as Error).message);
      setEmoji(null);
      setPhase("failed");
    }
  };

  const again = () => {
    setError(null);
    setPhase("scan");
    busy.current = false;
  };

  return (
    <Screen
      title="Pair with a laptop"
      right={<Button label="Close" onPress={() => router.back()} />}
      scroll={false}
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
        <View style={{ flex: 1, justifyContent: "center" }}>
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
        </View>
      ) : (
        <Viewfinder phase={phase} onCode={(d) => void scanned(d)} />
      )}
      {error ? (
        <Card tone="red">
          <T weight="600" color={c.red}>
            Couldn't pair
          </T>
          <T color={c.sub}>{error}</T>
          <Button label="Scan again" kind="primary" icon="scan" onPress={again} />
        </Card>
      ) : null}
      <T size={12} color={c.subtle} style={{ textAlign: "center" }}>
        The code works once, for two minutes. Nothing in it is a lasting secret.
      </T>
    </Screen>
  );
}

/** The camera, dimmed around a square in the middle where the code goes. */
function Viewfinder({ phase, onCode }: { phase: Phase; onCode: (data: string) => void }) {
  const { width } = useWindowDimensions();
  const side = Math.min(width * 0.68, 300);
  const shade = "rgba(17,16,25,0.62)";
  const color = phase === "failed" ? c.red : c.teal;
  return (
    <View style={{ flex: 1, borderRadius: r.l, overflow: "hidden", backgroundColor: "#000" }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={phase === "scan" ? (res) => onCode(res.data) : undefined}
      />
      <View pointerEvents="none" style={{ position: "absolute", inset: 0 }}>
        <View style={{ flex: 1, backgroundColor: shade }} />
        <View style={{ flexDirection: "row", height: side }}>
          <View style={{ flex: 1, backgroundColor: shade }} />
          <View style={{ width: side, height: side }}>
            <Corners side={side} color={color} />
            {phase === "connecting" ? (
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: shade,
                  gap: 12,
                }}
              >
                <ActivityIndicator color={c.teal} size="large" />
                <T weight="600">Connecting to the laptop…</T>
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, backgroundColor: shade }} />
        </View>
        <View style={{ flex: 1, backgroundColor: shade, alignItems: "center", paddingTop: 22 }}>
          <T weight="600" size={15}>
            {phase === "failed" ? "Paused" : "Point at the QR code on your laptop"}
          </T>
          <T color={c.dim} size={13} style={{ marginTop: 4 }}>
            Hold steady, about a hand's length away
          </T>
        </View>
      </View>
    </View>
  );
}

function Corners({ side, color }: { side: number; color: string }) {
  const len = side * 0.18;
  const w = 4;
  const at = [
    { top: 0, left: 0, borderTopWidth: w, borderLeftWidth: w, borderTopLeftRadius: r.m },
    { top: 0, right: 0, borderTopWidth: w, borderRightWidth: w, borderTopRightRadius: r.m },
    { bottom: 0, left: 0, borderBottomWidth: w, borderLeftWidth: w, borderBottomLeftRadius: r.m },
    {
      bottom: 0,
      right: 0,
      borderBottomWidth: w,
      borderRightWidth: w,
      borderBottomRightRadius: r.m,
    },
  ];
  return (
    <>
      {at.map((pos) => (
        <View
          key={JSON.stringify(pos)}
          style={{ position: "absolute", width: len, height: len, borderColor: color, ...pos }}
        />
      ))}
    </>
  );
}
