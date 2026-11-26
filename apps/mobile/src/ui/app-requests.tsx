/**
 * Another Vayu app on this phone asked to use ekatva (core/apps.ts): a sheet
 * over whatever screen you're on, saying who it is and what it wants, with
 * Allow (your fingerprint) or Don't allow. Your answer is pinned to the
 * app's signing certificate: a different app under its name never gets in.
 *
 * Closing the sheet (the shade, a stray tap) decides nothing: the request
 * waits, its notification stays, and the sheet is back the next time you
 * come to ekatva. Only "Don't allow" refuses.
 */
import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { AppRequest, RouteAnswer, RouteRequest } from "../core/apps";
import { Btn, Item, List, Sheet, Txt, toast } from "./lac";
import { useApp } from "./state";
import { k } from "./theme";

/** "ab12 cd34 …": the start of a certificate fingerprint, to compare at a glance. */
export const shortCert = (cert: string) =>
  (cert.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ") + (cert.length > 16 ? " …" : "");

export function AppRequests() {
  const { session, phase, confirm } = useApp();
  const [waiting, setWaiting] = useState<AppRequest[]>([]);
  const [routes, setRoutes] = useState<RouteRequest[]>([]);
  const [busy, setBusy] = useState(false);
  /** Packages whose sheet you closed: hidden until you come back to ekatva. */
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") setLater(new Set());
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!session) return;
    const read = () => {
      setWaiting(session.apps.waiting());
      setRoutes(session.apps.waitingRoutes());
    };
    read();
    return session.apps.onChange(read);
  }, [session]);
  const r = waiting.find((w) => !later.has(w.package));
  if (!session || phase !== "ready") return null;
  const route = routes[0];
  if (route) return <RouteSheet key={route.id} r={route} />;
  if (!r) return null;
  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (allow && !(await confirm(`Let ${r.manifest.name} use ekatva`))) return;
      await session.apps.decide(r.package, allow);
      toast(allow ? `${r.manifest.name} can use ekatva` : `${r.manifest.name} wasn't allowed`);
    } finally {
      setBusy(false);
    }
  };
  const asks = [...r.manifest.methods, ...r.manifest.events];
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 40 }]}>
      <Sheet
        title={`${r.manifest.name} wants to use ekatva`}
        onClose={() => setLater(new Set([...later, r.package]))}
      >
        <Txt size={14.5} color={k.sub} style={{ marginBottom: 14 }}>
          To talk to {r.manifest.name} on your laptop, through ekatva's encrypted link. It gets no
          keys and nothing else of ekatva's; the laptop still decides which phones may reach it.
        </Txt>
        {asks.length ? (
          <List inset={16} style={{ marginBottom: 14 }}>
            {asks.map((m) => (
              <Item
                key={m.name}
                title={m.why}
                titleColor={m.risk === "high" ? k.rose : m.risk === "medium" ? k.amber : undefined}
                sub={m.name}
              />
            ))}
          </List>
        ) : null}
        <Txt size={12.5} color={k.mute} style={{ marginBottom: 16 }}>
          {r.package}, version {r.manifest.version}
          {"\n"}Signed by {shortCert(r.cert)}
        </Txt>
        <View style={{ gap: 10 }}>
          <Btn label="Allow" kind="solid" onPress={() => void answer(true)} />
          <Btn label="Don't allow" onPress={() => void answer(false)} />
        </View>
      </Sheet>
    </View>
  );
}

/** An app wants another app (a route): the call waits here for you, up to a minute. */
function RouteSheet({ r }: { r: RouteRequest }) {
  const { session, confirm } = useApp();
  const [busy, setBusy] = useState(false);
  const where = r.to.startsWith("laptop:") ? "on your laptop" : "on this phone";
  const answer = async (a: RouteAnswer) => {
    if (busy) return;
    setBusy(true);
    try {
      if (a !== "refuse" && !(await confirm(`Let ${r.callerName} use ${r.toName}`))) return;
      session?.apps.decideRoute(r.id, a);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 40 }]}>
      {/* A stray tap refuses nothing: unanswered, it is refused after a minute. */}
      <Sheet title={`${r.callerName} wants to use ${r.toName}`} onClose={() => undefined}>
        <Txt size={14.5} color={k.sub} style={{ marginBottom: 14 }}>
          {r.toName} {where}: {r.method.why}
          {r.files.length ? `, with ${r.files.map((f) => f.name).join(", ")}` : ""}.
        </Txt>
        <View style={{ gap: 10 }}>
          {r.method.risk === "high" ? null : (
            <Btn label="Allow always" kind="solid" onPress={() => void answer("always")} />
          )}
          <Btn label="Just this once" onPress={() => void answer("once")} />
          <Btn label="Refuse" onPress={() => void answer("refuse")} />
        </View>
      </Sheet>
    </View>
  );
}
