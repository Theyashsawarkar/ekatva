import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { LaptopPasswords } from "../core/vault";
import { vaultBox } from "../platform";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Btn, Glyph, Sheet, Toggle, Txt, toast } from "../ui/lac";
import { useApp, useLaptop, useLink, usePoll } from "../ui/state";
import { font, k } from "../ui/theme";

/** The laptop said the password was wrong (UNAUTHORIZED: power.unlock's, or the link's login). */
const wrong = (e: unknown) => {
  const x = e as { data?: { code?: string }; code?: string } | null;
  return x?.data?.code === "UNAUTHORIZED" || x?.code === "UNAUTHORIZED";
};

/**
 * Unlocks the laptop's lock screen: your laptop password, typed into it by
 * ekatva; the laptop's own password check (PAM) decides. With "Remember" on,
 * the password is kept in this phone's vault, sealed by the keystore key
 * behind your fingerprint: each unlock opens it with one touch. A saved
 * password the laptop refuses is forgotten at once and never tried again
 * (three wrong ones lock the account on the laptop for 10 minutes).
 *
 * `?mode=login`: the laptop is at the login screen (after a restart):
 * the same password logs in, through ekatva-link and greetd.
 */
export default function LaptopUnlock() {
  const { session } = useApp();
  const laptop = useLaptop();
  const link = useLink();
  const login = useLocalSearchParams<{ mode?: string }>().mode === "login";
  const client = link.status === "online" ? session?.link.client : null;
  const connected = link.status === "online" && (login || !!client);
  const name = laptop?.name ?? "the laptop";

  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "saved": trying the saved one; "type": asking for it.
  const [step, setStep] = useState<"saved" | "type">(vaultBox ? "saved" : "type");
  const tried = useRef(false);

  // The same status Home shows (one shared poll): refreshed once this is done,
  // so its Lock/Unlock tile is right the moment the sheet closes.
  const status = usePoll(() => client?.status.query() ?? null, [client], 3000, { key: "status" });
  /** What happened, in the laptop's words: it was locked, or already unlocked. */
  const outcome = useRef<"locked" | "unlocked">("locked");

  const unlock = async (pw: string) => {
    if (login) {
      if (!session || link.status !== "online") throw new Error(`${name} isn't connected`);
      await session.link.askLink("login", { password: pw });
      return;
    }
    if (!client) throw new Error(`${name} isn't connected`);
    const r = await client.power.unlock.mutate({ password: pw });
    outcome.current = r?.was ?? "locked";
  };

  const done = () => {
    status.reload();
    toast(
      login
        ? `Logging in to ${name}…`
        : outcome.current === "unlocked"
          ? `${name} was already unlocked`
          : `Unlocked ${name}`,
    );
    router.back();
  };

  // With a saved password: one fingerprint, then the unlock.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once (`tried`); unlock and done are this render's
  useEffect(() => {
    if (step !== "saved" || tried.current || !connected || !laptop || !vaultBox) return;
    tried.current = true;
    const box = vaultBox;
    void (async () => {
      let saved: string | null = null;
      try {
        saved = await LaptopPasswords.get(box, laptop.key);
      } catch {
        // Cancelled the fingerprint: type it instead.
      }
      if (!saved) return setStep("type");
      setBusy(true);
      try {
        await unlock(saved);
        done();
      } catch (e) {
        if (wrong(e)) {
          // Changed on the laptop? Never try it again: forget it, ask.
          await LaptopPasswords.set(box, laptop.key, null).catch(() => undefined);
          setError("The saved password was wrong (changed on the laptop?). Type it once more.");
        } else setError(errorText(e));
        setStep("type");
      } finally {
        setBusy(false);
        saved = null;
      }
    })();
  }, [step, connected, laptop]);

  const submit = async () => {
    if (!password || !laptop) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      if (remember && vaultBox)
        await LaptopPasswords.set(vaultBox, laptop.key, password).catch(() =>
          toast("Unlocked, but the password wasn't saved"),
        );
      setPassword("");
      done();
    } catch (e) {
      setError(wrong(e) ? "Wrong password: still locked." : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <Glyph name="lock" color={k.amber} size={42} radius={13} />
        <View style={{ flex: 1 }}>
          <Txt
            display
            w="700"
            size={24}
            style={{ letterSpacing: -0.48, marginTop: 2, marginBottom: 4 }}
          >
            {login ? `Log in to ${name}` : `Unlock ${name}`}
          </Txt>
          <Txt size={13} color={k.sub}>
            Your password is typed into its lock screen; the laptop checks it, as if you typed it
            there.
          </Txt>
        </View>
      </View>

      {step === "saved" ? (
        <Txt size={15} color={k.sub}>
          {busy ? `Unlocking ${name}…` : "Touch the fingerprint sensor to use the saved password."}
        </Txt>
      ) : (
        <>
          <Txt size={13} color={k.sub} style={{ marginTop: 4 }}>
            {name}'s password
          </Txt>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              backgroundColor: k.ink,
              borderWidth: 1,
              borderColor: error ? `${k.rose}99` : k.line2,
              borderRadius: 14,
              paddingHorizontal: 14,
              height: 50,
              marginTop: 8,
            }}
          >
            <Icon name="lock" color={k.text} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void submit()}
              secureTextEntry
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="laptop password"
              placeholderTextColor={k.mute}
              accessibilityLabel={`${name}'s password`}
              style={{
                flex: 1,
                color: k.text,
                fontFamily: font.body,
                fontSize: 16,
                padding: 0,
                letterSpacing: password ? 3 : 0,
              }}
            />
          </View>
          {vaultBox ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 }}>
              <Toggle
                on={remember}
                onChange={setRemember}
                label="Remember it behind the fingerprint"
              />
              <Txt size={14} style={{ flex: 1 }}>
                Remember it on this phone, behind your fingerprint
              </Txt>
            </View>
          ) : null}
          <Btn
            label={login ? `Log in to ${name}` : `Unlock ${name}`}
            onPress={() => void submit()}
            disabled={!password || !connected}
            busy={busy}
          />
        </>
      )}
      {error ? (
        <Txt size={13} color={k.rose} style={{ marginTop: 10 }}>
          {error}
        </Txt>
      ) : null}
    </Sheet>
  );
}
