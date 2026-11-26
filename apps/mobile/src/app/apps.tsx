/**
 * Apps on this phone that talk through ekatva: the ones you allowed (each
 * pinned to its signing certificate), the ones you refused, and any waiting
 * for you. Taking an approval back cuts the app off at once.
 */

import type { AppInfo, AppRoute } from "@ekatva/protocol";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { Approval } from "../core/apps";
import { shortCert } from "../ui/app-requests";
import { H2, Item, List, Navbar, Page, Pill, Toggle, Txt, toast } from "../ui/lac";
import { useApp, useLink } from "../ui/state";
import { k } from "../ui/theme";

export default function Apps() {
  const { session } = useApp();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [routes, setRoutes] = useState<AppRoute[]>([]);
  const [laptop, setLaptop] = useState<AppInfo[]>([]);
  const [, redraw] = useState(0);
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  useEffect(() => {
    setLaptop([]);
    client?.apps.list
      .query()
      .then(setLaptop)
      .catch(() => setLaptop([]));
  }, [client]);
  const read = useCallback(async () => {
    if (!session) return;
    setRoutes(session.apps.allowedRoutes());
    redraw((n) => n + 1);
    setApprovals(await session.apps.approvals());
    setOnline(
      new Set(
        session.apps.hub
          .apps()
          .filter((a) => a.online)
          .map((a) => a.manifest.id),
      ),
    );
  }, [session]);
  useEffect(() => {
    if (!session) return;
    void read();
    return session.apps.onChange(() => void read());
  }, [session, read]);

  const revoke = async (a: Approval) => {
    if (!session) return;
    await session.apps.revoke(a.package);
    toast(`${a.name} can't use ekatva any more`);
  };
  const allowed = approvals.filter((a) => a.state === "allowed");
  const denied = approvals.filter((a) => a.state === "denied");

  return (
    <Page bottom={48}>
      <Navbar back="Settings" mid="Apps" />
      <Txt size={14.5} color={k.sub} style={{ marginBottom: 18 }}>
        Apps link once, from their own settings, and stay linked. Your answer is tied to how an app
        is signed, so a different app under the same name never gets in. The switch is whether your
        laptop may reach that app.
      </Txt>
      <H2>Linked on this phone</H2>
      {allowed.length ? (
        <List>
          {allowed.map((a) => (
            <Item
              key={a.package}
              glyph="apps"
              glyphColor={online.has(a.id) ? k.sage : k.mute}
              title={a.name}
              sub={`${online.has(a.id) ? "Connected now" : "Not open"}, signed by ${shortCert(a.cert)}`}
              right={
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Pill label="Unlink" tone="rose" onPress={() => void revoke(a)} />
                  <Toggle
                    on={session?.apps.reachable(a.id) ?? false}
                    onChange={(on) => void session?.apps.setReachable(a.id, on)}
                    label={`Your laptop may reach ${a.name}`}
                  />
                </View>
              }
            />
          ))}
        </List>
      ) : (
        <Txt size={14} color={k.mute} style={{ marginBottom: 8 }}>
          None yet. In an app's settings, tap "Link with ekatva".
        </Txt>
      )}
      {denied.length ? (
        <View>
          <H2>Not allowed</H2>
          <List>
            {denied.map((a) => (
              <Item
                key={a.package}
                glyph="apps"
                glyphColor={k.mute}
                title={a.name}
                sub="Remove this to let it link again"
                right={<Pill label="Remove" onPress={() => void revoke(a)} />}
              />
            ))}
          </List>
        </View>
      ) : null}
      {laptop.length ? (
        <View>
          <H2>On the laptop</H2>
          <List>
            {laptop.map((a) => (
              <Item
                key={a.id}
                glyph="apps"
                glyphColor={a.online && a.granted ? k.sage : k.mute}
                title={a.name}
                sub={a.granted ? (a.online ? "Running" : "Not running") : "Not for this phone"}
              />
            ))}
          </List>
        </View>
      ) : null}
      {routes.length ? (
        <View>
          <H2>Allowed to use another app</H2>
          <List>
            {routes.map((r) => (
              <Item
                key={`${r.caller} ${r.to}`}
                glyph="apps"
                glyphColor={k.mute}
                title={`${r.caller} → ${r.to.split(":")[1]}`}
                sub={r.to.startsWith("laptop:") ? "On the laptop" : "On this phone"}
                right={
                  <Pill
                    label="Remove"
                    onPress={() => void session?.apps.removeRoute(r.caller, r.to)}
                  />
                }
              />
            ))}
          </List>
        </View>
      ) : null}
    </Page>
  );
}
