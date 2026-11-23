import { parseOffer, toB64u } from "@ekatva/link";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import { errorText } from "../ui/errors";
import { Btn, Glyph, Navbar, Page, Panel, Txt } from "../ui/lac";
import { useApp } from "../ui/state";
import { k } from "../ui/theme";

type Phase = "scan" | "connecting" | "failed";

/**
 * Scan the laptop's QR code; compare the emoji; confirm on the laptop. The
 * scanner is Google's (Play services): no camera permission, no model in the
 * app. Pasting the `ekatva://pair` link works too.
 */
export default function Pair() {
  const { session } = useApp();
  const [phase, setPhase] = useState<Phase>("scan");
  const [emoji, setEmoji] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The code was a paired laptop's: connecting, not pairing. */
  const [known, setKnown] = useState<string | null>(null);
  const busy = useRef(false);

  const scanned = async (data: string) => {
    if (busy.current || !session) return;
    if (!data.startsWith("ekatva://pair")) {
      setError("That isn't an ekatva pairing code. On the laptop, run ekatva pair.");
      setPhase("failed");
      return;
    }
    busy.current = true;
    setError(null);
    setPhase("connecting");
    let was: string | null = null;
    try {
      was = session.laptops.get(toB64u(parseOffer(data).key))?.name ?? null;
    } catch {
      // damaged: pair() says so
    }
    setKnown(was);
    try {
      const laptop = await session.link.pair(data, setEmoji);
      setDone(laptop.name);
      setTimeout(() => router.back(), 1200);
    } catch (e) {
      // Stop here: rescanning the same code would just fail again.
      setError(errorText(e));
      setEmoji(null);
      setPhase("failed");
    }
  };

  const scan = async () => {
    setError(null);
    setPhase("scan");
    busy.current = false;
    if (!phone) {
      setError("This build can't scan; paste the link instead.");
      setPhase("failed");
      return;
    }
    try {
      await scanned(await phone.scanQr());
    } catch (e) {
      // Closing the scanner isn't an error: just stay here.
      if (!/cancel/i.test(errorText(e))) {
        setError(errorText(e));
        setPhase("failed");
      }
    }
  };
  const paste = async () => {
    setError(null);
    busy.current = false;
    await scanned((await Clipboard.getStringAsync()).trim());
  };
  const again = () => void scan();
  // Straight to the scanner when this opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    void scan();
  }, []);

  return (
    <Page scroll={false} bottom={24}>
      <Navbar back="Close" mid="Pair with a laptop" />
      {done && !emoji ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Panel
            style={{
              alignItems: "center",
              paddingVertical: 28,
              paddingHorizontal: 18,
              gap: 12,
              borderColor: `${k.sage}73`,
            }}
          >
            <Glyph name="check" color={k.sage} size={56} radius={18} />
            <Txt display w="600" size={19} align="center">
              Connected to {done}
            </Txt>
            <Txt size={14} color={k.sub} align="center" style={{ lineHeight: 20 }}>
              It knows the way now: on any network, the phone comes back by itself.
            </Txt>
          </Panel>
        </View>
      ) : emoji ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Panel
            style={{
              alignItems: "center",
              paddingVertical: 28,
              paddingHorizontal: 18,
              gap: 12,
              borderColor: `${k.brass}73`,
            }}
          >
            <Txt size={44} style={{ letterSpacing: 10 }}>
              {emoji.join(" ")}
            </Txt>
            <Txt display w="600" size={19} align="center">
              {done ? `Paired with ${done}` : "Does your laptop show the same four?"}
            </Txt>
            {done ? null : (
              <Txt size={14} color={k.sub} align="center" style={{ lineHeight: 20 }}>
                If they match, confirm on the laptop. If they don't, refuse there: someone else may
                have used the code.
              </Txt>
            )}
          </Panel>
        </View>
      ) : (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Panel style={{ padding: 20, alignItems: "center", gap: 12 }}>
            {phase === "connecting" ? (
              <>
                <ActivityIndicator color={k.brass} size="large" />
                <Txt w="600">{known ? `Connecting to ${known}…` : "Connecting to the laptop…"}</Txt>
                <Txt size={13} color={k.sub} align="center">
                  Through its tunnel or on this Wi-Fi, whichever answers
                </Txt>
              </>
            ) : (
              <>
                <Glyph name="qr" color={k.brass2} size={48} radius={14} />
                <Txt display w="600" size={19} align="center">
                  Scan the laptop's code
                </Txt>
                <Txt size={14} color={k.sub} align="center" style={{ lineHeight: 20 }}>
                  On the laptop, open ekatva's window (Super+Ctrl+O) or run ekatva pair, then scan
                  the QR code. It works from any network: a new laptop pairs, a paired one just
                  connects.
                </Txt>
                <Btn
                  label="Scan the code"
                  icon="qr"
                  kind="solid"
                  onPress={() => void scan()}
                  style={{ alignSelf: "stretch" }}
                />
                <Btn
                  label="Paste the link"
                  icon="clip"
                  onPress={() => void paste()}
                  style={{ alignSelf: "stretch", marginTop: 0 }}
                />
              </>
            )}
          </Panel>
        </View>
      )}
      {error ? (
        <Panel style={{ padding: 16, marginTop: 12, borderColor: `${k.rose}73` }}>
          <Txt w="600" color={k.rose}>
            {known ? `Couldn't connect to ${known}` : "Couldn't pair"}
          </Txt>
          <Txt size={14} color={k.sub} style={{ marginTop: 4 }}>
            {error}
          </Txt>
          <Btn label="Scan again" kind="solid" onPress={again} />
        </Panel>
      ) : null}
      <Txt size={12.5} color={k.mute} align="center" style={{ marginTop: 14 }}>
        The code works for two minutes. Nothing in it is a lasting secret: the connection is
        end-to-end encrypted with this phone's own key.
      </Txt>
    </Page>
  );
}
