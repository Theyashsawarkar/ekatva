/**
 * Home: the control centre. The laptop's name, what asks for you (root,
 * an agent's question), then the grid: the laptop at a glance, what's
 * playing, jyoti (keep it awake; swipe it), volume and brightness; then the tools.
 */
import type { JyotiLevel, MediaAction } from "@ekatva/protocol";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { sameMedia } from "../../core/equal";
import { agentRoute } from "../../ui/agents/route";
import { AtLoginScreen } from "../../ui/at-login-screen";
import { errorText } from "../../ui/errors";
import { AppearanceTile } from "../../ui/home/appearance-tile";
import { DeviceTile } from "../../ui/home/device-tile";
import { JyotiTile } from "../../ui/home/jyoti-tile";
import { LevelTile } from "../../ui/home/level-tile";
import { MediaTile } from "../../ui/home/media-tile";
import { AsksRow, Tools } from "../../ui/home/parts";
import { useAppearance } from "../../ui/home/use-appearance";
import { Icon } from "../../ui/icon";
import { Btn, Glyph, Page, Panel, Pill, Txt, toast } from "../../ui/lac";
import { LaptopBell } from "../../ui/notes/bell";
import { usePermissions } from "../../ui/permissions";
import { useApp, useLaptop, useLink, usePoll, useWatch, watchOf } from "../../ui/state";
import { k } from "../../ui/theme";

/** Between tiles; and between the two capsules (wider, so they're narrower). */
const GAP = 12;
const CAPSULE_GAP = 22;

/** dvarapala lets a root request wait this long. */
const ROOT_EXPIRES_MS = 10 * 60_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Home: the laptop's, or the login screen's when nobody is logged in on it. */
export default function Home() {
  const link = useLink();
  if (link.status === "online" && link.session === false) return <AtLoginScreen />;
  return <LaptopHome />;
}

function LaptopHome() {
  const { session, alerts, dismissAlert, confirm } = useApp();
  const link = useLink();
  const laptop = useLaptop();
  const client = link.status === "online" ? session?.link.client : null;
  const status = usePoll(() => client?.status.query() ?? null, [client], 3000, { key: "status" });
  // The lock tile follows what was just done until the laptop's next status says so too.
  const [lockGuess, setLockGuess] = useState<boolean | null>(null);
  const [locking, setLocking] = useState(false);
  const statusLocked = status.data?.locked ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new answer from the laptop replaces the guess
  useEffect(() => setLockGuess(null), [statusLocked]);
  const isLocked = lockGuess ?? statusLocked ?? false;
  // Pushed by the laptop as they change (one shared subscription each), polled only as a safety net.
  const jyoti = useWatch(
    "jyoti",
    () => client?.jyoti.get.query() ?? null,
    watchOf(client?.jyoti.watch.subscribe),
    [client],
  );
  // Media: a moving position alone isn't a change (the rim runs on by itself).
  const media = useWatch(
    "media.get",
    () => client?.media.get.query() ?? null,
    watchOf(client?.media.watch.subscribe),
    [client],
    { equal: sameMedia },
  );
  const agents = useWatch(
    "agents.list",
    () => client?.agents.list.query() ?? null,
    watchOf(client?.agents.watch.subscribe),
    [client],
  );
  // Root requests: only when this phone may answer them (else quietly nothing).
  const roots = useWatch(
    "root.pending",
    () => client?.root.pending.query().catch(() => []) ?? null,
    watchOf(client?.root.watch.subscribe),
    [client],
  );

  // The permissions ekatva needs and Android hasn't granted yet: a reminder until they are.
  const { perms } = usePermissions();
  const needed = (perms ?? []).filter((p) => p.essential && !p.on);
  const look = useAppearance(client, session, laptop?.name ?? "the laptop");
  // Set right away on a swipe; the laptop's own reading replaces it on the next poll.
  const [level, setLevel] = useState<JyotiLevel | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading clears what was set by hand
  useEffect(() => setLevel(null), [jyoti.data?.level]);

  const root = roots.data?.[0] ?? null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!root) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [root]);

  const name = laptop?.name ?? "ekatva";
  const [grid, setGrid] = useState(0);
  const col = grid ? (grid - GAP) / 2 : "48%";
  const head = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "space-between",
        marginTop: 6,
        marginBottom: 12,
      }}
    >
      <View>
        <Txt display w="700" size={32} style={{ letterSpacing: -0.64, lineHeight: 34 }}>
          {name}
        </Txt>
        <Txt deva size={18} color={k.brass}>
          एकत्व
        </Txt>
      </View>
      <LaptopBell client={client ?? null} />
    </View>
  );

  if (link.status === "unpaired")
    return (
      <Page>
        {head}
        <Panel style={{ padding: 18, alignItems: "center", gap: 10, marginTop: 14 }}>
          <Glyph name="qr" color={k.brass2} size={48} radius={14} />
          <Txt display w="600" size={19}>
            Pair with your laptop
          </Txt>
          <Txt size={14} color={k.sub} align="center">
            On the laptop, run ekatva pair (or open ekatva there), then scan the code.
          </Txt>
          <Btn
            label="Scan the code"
            kind="solid"
            onPress={() => router.push("/pair")}
            style={{ alignSelf: "stretch" }}
          />
        </Panel>
      </Page>
    );

  const ask = (agents.data ?? []).find((a) => a.question);
  const jyotiLevel: JyotiLevel = level ?? jyoti.data?.level ?? status.data?.jyoti ?? "off";

  const setJyoti = async (l: JyotiLevel) => {
    if (!client) return;
    setLevel(l);
    try {
      await client.jyoti.set.mutate({ level: l });
      jyoti.reload();
    } catch (e) {
      setLevel(null);
      toast(errorText(e));
    }
  };
  const control = (player: string, action: MediaAction) =>
    void client?.media.control
      .mutate({ player, action })
      .then(media.reload, (e: unknown) => toast(errorText(e)));
  const seek = (player: string, position: number) =>
    void client?.media.seek
      .mutate({ player, position })
      .then(media.reload, (e: unknown) => toast(errorText(e)));
  const m = media.data;

  return (
    <Page>
      {head}

      {alerts.map((a, i) => (
        <View key={a} style={[row, { borderColor: `${k.rose}73` }]}>
          <Icon name="warn" size={18} color={k.rose} />
          <Txt size={14} color={k.text} style={{ flex: 1 }}>
            {a}
          </Txt>
          <Pill label="Dismiss" onPress={() => dismissAlert(i)} />
        </View>
      ))}

      {link.status !== "online" ? (
        <View style={row}>
          <Icon
            name={link.status === "connecting" ? "sync" : "offline"}
            size={18}
            color={k.steel}
          />
          <Txt size={14} color={k.sub} style={{ flex: 1 }} lines={2}>
            {link.status === "connecting"
              ? "Connecting…"
              : (link.status === "offline" && link.error && errorText(link.error)) ||
                "Not connected"}
          </Txt>
        </View>
      ) : null}

      {needed.length ? (
        <AsksRow
          tone="amber"
          title={`ekatva needs ${needed.length} permission${needed.length === 1 ? "" : "s"}`}
          sub={needed.map((p) => p.title).join(", ")}
          action="Allow"
          onPress={() => router.push("/permissions")}
        />
      ) : null}
      {root ? (
        <AsksRow
          tone="rose"
          title={`${root.requester} wants root`}
          sub={`${root.commands.length} command${root.commands.length === 1 ? "" : "s"}, ${clock(root.at + ROOT_EXPIRES_MS - now)} left`}
          action="Review"
          onPress={() => router.push({ pathname: "/root/[id]", params: { id: root.id } })}
        />
      ) : null}
      {ask ? (
        <AsksRow
          tone="amber"
          title={`${ask.name || ask.session} asks you`}
          sub={ask.question?.text ?? ""}
          action="Answer"
          onPress={() => router.push(agentRoute(ask.id))}
        />
      ) : null}

      {/* Two equal columns, measured: every tile is exactly half a row, so
          jyoti lines up with the battery above it and the capsules with
          the song. The capsules sit further apart, so they're a little narrower. */}
      <View
        style={{ marginTop: 14, gap: GAP }}
        onLayout={(e) => setGrid(e.nativeEvent.layout.width)}
      >
        <View style={{ flexDirection: "row", gap: GAP, height: 188 }}>
          <View style={{ width: col }}>
            <DeviceTile
              name={name}
              status={status.data}
              via={link.status === "online" ? link.via : null}
            />
          </View>
          <View style={{ width: col }}>
            <MediaTile media={m} onAction={control} onSeek={seek} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: GAP, height: 188 }}>
          <View style={{ width: col }}>
            <JyotiTile level={jyotiLevel} onSet={(l) => void setJyoti(l)} disabled={!client} />
          </View>
          <View style={{ width: col, flexDirection: "row", gap: CAPSULE_GAP }}>
            <LevelTile
              icon={m?.volume?.muted ? "mute" : "vol"}
              label="Volume"
              value={client ? (m?.volume?.percent ?? null) : null}
              onSet={(percent) =>
                void client?.media.volume
                  .mutate({ percent })
                  .catch((e: unknown) => toast(errorText(e)))
              }
            />
            <LevelTile
              icon="sun"
              min={10}
              label="Brightness"
              value={client ? (m?.brightness ?? null) : null}
              onSet={(percent) =>
                void client?.media.brightness
                  .mutate({ percent })
                  .catch((e: unknown) => toast(errorText(e)))
              }
            />
          </View>
        </View>
      </View>

      <AppearanceTile
        laptopName={name}
        ace={look.ace}
        aceBlocked={look.aceBlocked}
        phone={look.phone}
        follow={look.follow}
        onFollow={look.toggleFollow}
        onTap={() => void look.tap()}
      />

      <Tools
        wide={[
          {
            icon: "pad",
            label: "Trackpad",
            sub: "Cursor, keys",
            onPress: () => router.push("/trackpad"),
            disabled: !client,
          },
          {
            icon: "term",
            label: "Terminal",
            sub: "Your tmux sessions",
            color: k.sage,
            onPress: () => router.push("/terminal"),
            disabled: !client,
          },
        ]}
        small={[
          { icon: "clip", label: "Clipboard", onPress: () => router.push("/clipboard") },
          { icon: "send", label: "Send", onPress: () => router.push("/send"), disabled: !client },
          isLocked
            ? {
                icon: "lock",
                label: "Unlock",
                color: k.amber,
                disabled: !client,
                onPress: () => router.push("/laptop-unlock"),
              }
            : {
                icon: "lock",
                label: locking ? "Locking…" : "Lock",
                disabled: !client || locking,
                onPress: () => {
                  if (!client || locking) return;
                  setLocking(true);
                  void client.power.lock
                    .mutate()
                    .then(
                      () => {
                        // Shown at once; the next status agrees.
                        setLockGuess(true);
                        toast(`Locked ${name}`);
                        status.reload();
                      },
                      (e: unknown) => toast(errorText(e)),
                    )
                    .finally(() => setLocking(false));
                },
              },
          {
            icon: "moon",
            label: "Sleep",
            disabled: !client,
            onPress: () =>
              void confirm(
                jyotiLevel === "off"
                  ? `Put ${name} to sleep?`
                  : `Put ${name} to sleep? Jyoti stays lit: it lets go for this sleep and is lit again when ${name} wakes.`,
              ).then(async (ok) => {
                if (!ok || !client) return;
                try {
                  await client.power.suspend.mutate();
                  toast(
                    jyotiLevel === "off"
                      ? `${name} is going to sleep`
                      : `${name} is going to sleep (jyoti stays lit)`,
                  );
                } catch (e) {
                  toast(errorText(e));
                }
              }),
          },
        ]}
      />
    </Page>
  );
}

const row = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 12,
  paddingVertical: 12,
  paddingHorizontal: 14,
  borderRadius: 20,
  borderWidth: 1,
  borderColor: k.line,
  backgroundColor: k.ink2,
  marginTop: 10,
};
