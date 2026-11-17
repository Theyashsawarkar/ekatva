/**
 * While the laptop rings this phone: the whole screen turns rose with one
 * big Stop button, over every screen, even before the app is unlocked
 * (stopping a ring needs no password).
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import { Icon } from "./icon";
import { Txt } from "./lac";
import { useLaptop } from "./state";
import { k } from "./theme";

/** Is the phone ringing now? (false where the native module is missing or fails.) */
function ringingNow(): boolean {
  if (!phone) return false;
  try {
    return phone.ringing();
  } catch {
    return false;
  }
}

export function RingBanner() {
  const [ringing, setRinging] = useState(ringingNow);
  const laptop = useLaptop();
  useEffect(() => {
    if (!phone) return;
    const sub = phone.addListener("onRing", (e) => setRinging(e.ringing));
    return () => sub.remove();
  }, []);
  if (!ringing) return null;
  const stop = () => {
    phone?.stopRinging();
    setRinging(false);
  };
  return (
    <View
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: 100,
          elevation: 30,
          backgroundColor: k.rose,
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
        },
      ]}
    >
      <Icon name="ring" size={70} color={k.onRose} stroke={1.5} />
      <Txt
        display
        w="700"
        size={34}
        color={k.onRose}
        align="center"
        style={{ lineHeight: 37, marginTop: 16 }}
      >
        {laptop?.name ?? "Your laptop"} is looking{"\n"}for this phone
      </Txt>
      <Txt w="500" color={k.onRose} style={{ marginTop: 16 }}>
        Ringing at full volume
      </Txt>
      <Pressable
        onPress={stop}
        accessibilityRole="button"
        accessibilityLabel="Stop ringing"
        style={({ pressed }) => ({
          marginTop: 76,
          backgroundColor: k.onRose,
          paddingVertical: 18,
          paddingHorizontal: 40,
          borderRadius: 999,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Txt w="700" size={18} color={k.rose}>
          Stop ringing
        </Txt>
      </Pressable>
    </View>
  );
}
