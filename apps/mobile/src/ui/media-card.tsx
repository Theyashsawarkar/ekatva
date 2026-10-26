/** What's playing on the laptop, its volume and brightness: the home screen's media card. */

import type { Media, MediaAction, Player } from "@ekatva/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { Card, type Icon, T } from "./kit";
import { usePoll } from "./state";
import { c } from "./theme";

type Client = {
  media: {
    get: { query(): Promise<Media> };
    control: { mutate(i: { player: string; action: MediaAction }): Promise<unknown> };
    seek: { mutate(i: { player: string; position: number }): Promise<unknown> };
    volume: { mutate(i: { percent?: number; muted?: boolean }): Promise<unknown> };
    brightness: { mutate(i: { percent: number }): Promise<unknown> };
  };
};

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Where a playing track is now, moving on from when it was read. */
function positionOf(p: Player, now: number): number | null {
  if (p.position === null) return null;
  const at = p.status === "Playing" ? p.position + (now - p.at) : p.position;
  return p.length ? Math.min(at, p.length) : at;
}

/** A bar you tap to set: 0..1. */
function Bar({
  value,
  onSet,
  color = c.accent,
}: {
  value: number;
  onSet?: (v: number) => void;
  color?: string;
}) {
  const [width, setWidth] = useState(1);
  return (
    <Pressable
      disabled={!onSet}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)}
      onPress={(e) => onSet?.(Math.max(0, Math.min(1, e.nativeEvent.locationX / width)))}
      hitSlop={10}
      style={{ height: 6, borderRadius: 3, backgroundColor: c.overlay, justifyContent: "center" }}
    >
      <View
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
          height: 6,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
    </Pressable>
  );
}

function Round({
  icon,
  onPress,
  big,
  label,
}: {
  icon: Icon;
  onPress: () => void;
  big?: boolean;
  label: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: big ? 52 : 40,
        height: big ? 52 : 40,
        borderRadius: 26,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: big ? c.accent : "transparent",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={big ? 26 : 22} color={big ? c.crust : c.sub} />
    </Pressable>
  );
}

/** A level with − and +, and a bar to tap. */
function Level({
  icon,
  value,
  onSet,
  label,
  onIcon,
}: {
  icon: Icon;
  value: number;
  onSet: (v: number) => void;
  label: string;
  onIcon?: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Pressable accessibilityLabel={label} onPress={onIcon} disabled={!onIcon} hitSlop={8}>
        <Ionicons name={icon} size={18} color={c.dim} />
      </Pressable>
      <Pressable onPress={() => onSet(value - 5)} hitSlop={6}>
        <Ionicons name="remove" size={18} color={c.subtle} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Bar value={value / 100} onSet={(v) => onSet(Math.round(v * 100))} />
      </View>
      <Pressable onPress={() => onSet(value + 5)} hitSlop={6}>
        <Ionicons name="add" size={18} color={c.subtle} />
      </Pressable>
      <T size={12} color={c.subtle} mono style={{ width: 34, textAlign: "right" }}>
        {value}%
      </T>
    </View>
  );
}

export function MediaCard({ client }: { client: Client | null }) {
  const media = usePoll(() => client?.media.get.query() ?? null, [client], 2000);
  const [now, setNow] = useState(Date.now());
  const [pick, setPick] = useState<string | null>(null);
  // Set right away on tap; the laptop's own reading replaces it on the next poll.
  const [volume, setVolume] = useState<number | null>(null);
  const [light, setLight] = useState<number | null>(null);
  const m = media.data;
  const player = m?.players.find((p) => p.id === pick) ?? m?.players[0] ?? null;

  useEffect(() => {
    if (player?.status !== "Playing") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [player?.status]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading clears what was set by hand
  useEffect(() => {
    setVolume(null);
    setLight(null);
  }, [m]);

  if (!client || !m) return null;
  const act = (action: MediaAction) =>
    player && void client.media.control.mutate({ player: player.id, action }).then(media.reload);
  const position = player ? positionOf(player, now) : null;
  const vol = volume ?? m.volume?.percent ?? 0;
  const bright = light ?? m.brightness ?? 0;

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T weight="700">Media</T>
        <View style={{ flex: 1 }} />
        {m.players.length > 1 ? (
          m.players.map((p) => (
            <Pressable key={p.id} onPress={() => setPick(p.id)} hitSlop={4}>
              <T size={12} weight="600" color={p.id === player?.id ? c.accent : c.subtle}>
                {p.name}
              </T>
            </Pressable>
          ))
        ) : player ? (
          <T size={12} color={c.subtle}>
            {player.name}
          </T>
        ) : null}
      </View>
      {player ? (
        <>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            {player.art ? (
              <Image
                source={{ uri: player.art }}
                style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: c.overlay }}
              />
            ) : (
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 10,
                  backgroundColor: c.overlay,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="musical-notes" size={24} color={c.subtle} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <T weight="700" lines={1}>
                {player.title || "Nothing playing"}
              </T>
              <T size={12} color={c.subtle} lines={1}>
                {[player.artist, player.album].filter(Boolean).join(" · ")}
              </T>
            </View>
          </View>
          {position !== null && player.length ? (
            <View style={{ gap: 4 }}>
              <Bar
                value={position / player.length}
                onSet={(v) =>
                  void client.media.seek
                    .mutate({ player: player.id, position: Math.round(v * (player.length ?? 0)) })
                    .then(media.reload)
                }
              />
              <View style={{ flexDirection: "row" }}>
                <T size={11} color={c.subtle} mono>
                  {clock(position)}
                </T>
                <View style={{ flex: 1 }} />
                <T size={11} color={c.subtle} mono>
                  {clock(player.length)}
                </T>
              </View>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              alignItems: "center",
              gap: 18,
            }}
          >
            <Round icon="play-skip-back" label="Previous" onPress={() => act("previous")} />
            <Round
              big
              icon={player.status === "Playing" ? "pause" : "play"}
              label={player.status === "Playing" ? "Pause" : "Play"}
              onPress={() => act("play-pause")}
            />
            <Round icon="play-skip-forward" label="Next" onPress={() => act("next")} />
          </View>
        </>
      ) : (
        <T size={12} color={c.subtle}>
          Nothing is playing.
        </T>
      )}
      {m.volume ? (
        <Level
          icon={m.volume.muted ? "volume-mute" : "volume-high"}
          label={m.volume.muted ? "Unmute" : "Mute"}
          value={vol}
          onIcon={() =>
            void client.media.volume.mutate({ muted: !m.volume?.muted }).then(media.reload)
          }
          onSet={(v) => {
            const percent = Math.max(0, Math.min(100, v));
            setVolume(percent);
            void client.media.volume.mutate({ percent });
          }}
        />
      ) : null}
      {m.brightness !== null ? (
        <Level
          icon="sunny"
          label="Brightness"
          value={bright}
          onSet={(v) => {
            const percent = Math.max(1, Math.min(100, v));
            setLight(percent);
            void client.media.brightness.mutate({ percent });
          }}
        />
      ) : null}
    </Card>
  );
}
