import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { errorText } from "./errors";
import { Btn, Glyph, Page, Panel, Txt, toast } from "./lac";
import { useApp, useLaptop, useLink } from "./state";
import { k } from "./theme";

interface LinkStatus {
  name: string;
  session: boolean;
  loginScreen: boolean;
  battery: { percent: number; charging: boolean } | null;
  uptime: number;
}

/**
 * Home while the laptop has nobody logged in (after a restart): ekatva-link
 * answers on its own, so the phone can log in, or restart or power off the
 * laptop. Each needs its grant (unlock, power), as on the laptop.
 */
export function AtLoginScreen() {
  const { session, confirm } = useApp();
  const laptop = useLaptop();
  const link = useLink();
  const name = laptop?.name ?? "the laptop";
  const grants = link.status === "online" ? link.grants : [];
  const [status, setStatus] = useState<LinkStatus | null>(null);

  useEffect(() => {
    if (!session || link.status !== "online") return;
    let alive = true;
    const read = () =>
      session.link
        .askLink<LinkStatus>("status")
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session, link.status]);

  const power = (what: "reboot" | "poweroff") =>
    void confirm(what === "reboot" ? `Restart ${name}?` : `Power off ${name}?`).then(async (ok) => {
      if (!ok || !session) return;
      try {
        await session.link.askLink(what);
        toast(what === "reboot" ? `${name} is restarting` : `${name} is powering off`);
      } catch (e) {
        toast(errorText(e));
      }
    });

  const battery = status?.battery
    ? `${status.battery.percent}%${status.battery.charging ? ", charging" : ""}`
    : null;

  return (
    <Page title={name}>
      <Panel>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Glyph name="lock" color={k.amber} size={42} radius={13} />
          <View style={{ flex: 1 }}>
            <Txt display w="700" size={20}>
              At the login screen
            </Txt>
            <Txt size={13} color={k.sub} style={{ marginTop: 2 }}>
              {status && !status.loginScreen
                ? "Starting up: the login screen isn't ready yet."
                : "It restarted and nobody is logged in yet."}
              {battery ? ` Battery ${battery}.` : ""}
            </Txt>
          </View>
        </View>
      </Panel>
      {grants.includes("unlock") ? (
        <Btn
          label={`Log in to ${name}`}
          kind="solid"
          disabled={status !== null && !status.loginScreen}
          onPress={() => router.push("/laptop-unlock?mode=login")}
        />
      ) : (
        <Txt size={13} color={k.sub} style={{ marginTop: 14 }}>
          Logging in from this phone needs the "Unlock the laptop" permission (ekatva grant …
          unlock).
        </Txt>
      )}
      {grants.includes("power") ? (
        <>
          <Btn label="Restart" onPress={() => power("reboot")} />
          <Btn label="Power off" kind="danger" onPress={() => power("poweroff")} />
        </>
      ) : null}
    </Page>
  );
}
