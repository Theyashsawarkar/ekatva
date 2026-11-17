/**
 * What's playing on the laptop, as a record: the title, a vinyl peeking in
 * from the corner with the cover as its label, turning while it plays, its
 * rim the progress, and play/pause.
 *
 * Two gestures:
 *  - swipe the tile: left for the next song, right for the previous one.
 *    The whole tile follows your finger with the song you're going to
 *    already sliding in beside it (nāda tells which, through MPD); let go
 *    past a fifth of the way and it settles there.
 *  - hold the record, then turn it: forward or back to seek, one turn = 30
 *    seconds. Holding (about a third of a second) is what grabs it: a buzz,
 *    the record lifts, and the time shows while you turn. A plain slide over
 *    the record is a swipe like anywhere else on the tile. (Without a hold
 *    the turn never starts; with one, the swipe gives way.)
 *
 * Cheap while it plays: the rim's progress runs on the UI thread (two
 * clipped half-rings turned by Reanimated, from the laptop's last reading to
 * the end of the song), so nothing re-renders every second and no SVG is
 * redrawn; the record stops turning when Home isn't in front.
 */
import type { Media, MediaAction, Player } from "@ekatva/protocol";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  Easing as REasing,
  runOnJS,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "../icon";
import { Txt } from "../lac";
import { useApp, useLink } from "../state";
import { font, k } from "../theme";
import { useArt } from "./art-cache";
import { useMotion } from "./motion";
import { Tile } from "./parts";

const REC = 160; // the record
const ARC = 172; // its progress rim
const RING = 2.5; // the rim's width
const TURN_MS = 30_000; // one full turn of the record
const HOLD_MS = 320; // how long a hold grabs the record
const AnimatedInput = Reanimated.createAnimatedComponent(TextInput);
const NO_COVER = ["#cdb38a", "#8a6a50", "#3a2e45", "#6b4a3a"] as const;

/** Where a playing track is now, moving on from when it was read. */
function positionOf(p: Player, now: number): number | null {
  if (p.position === null) return null;
  const at = p.status === "Playing" ? p.position + (now - p.at) : p.position;
  return p.length ? Math.min(at, p.length) : at;
}

interface Song {
  title: string;
  artist: string;
  art: string | null;
}

export function MediaTile({
  media,
  onAction,
  onSeek,
}: {
  media: Media | null;
  onAction: (player: string, action: MediaAction) => void;
  /** Moves the track to `position` ms. */
  onSeek: (player: string, position: number) => void;
}) {
  const player = media?.players[0] ?? null;
  // The cover: fetched once per song by id, then kept.
  const { session } = useApp();
  const link = useLink();
  const art = useArt(player?.artId, link.status === "online" ? session?.link.client : null);
  const playing = player?.status === "Playing";
  const motion = useMotion();
  /** Where the song is right now (read when needed, never on a timer). */
  const posNow = () => (player ? positionOf(player, Date.now()) : null);
  const seekable = !!player && player.position !== null;

  // The rim: from the laptop's last reading, running to the end of the song on the UI thread.
  const progress = useSharedValue(0);
  const seeking = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-synced on each new reading
  useEffect(() => {
    if (seeking.current) return;
    const len = player?.length ?? 0;
    const at = posNow();
    if (!len || at == null) {
      cancelAnimation(progress);
      progress.set(0);
      return;
    }
    progress.set(Math.max(0, Math.min(1, at / len)));
    if (playing && motion)
      progress.set(
        withTiming(1, {
          duration: Math.max(0, len - at),
          easing: REasing.linear,
        }),
      );
  }, [player?.id, player?.position, player?.at, player?.length, playing, motion]);

  // After a swipe the new song shows at once, until the laptop says what's playing.
  const [shown, setShown] = useState<Song | null>(null);
  const title = player ? player.title || player.name : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new song from the laptop replaces the guess
  useEffect(() => setShown(null), [title]);
  const current: Song = shown ?? {
    title: player ? title : "Nothing playing",
    artist: player ? player.artist || player.album || player.name : "Play something on the laptop",
    art: player ? art : null,
  };
  const prev: Song = {
    title: player?.prev?.title ?? "Previous song",
    artist: player?.prev?.artist ?? "",
    art: null,
  };
  const next: Song = {
    title: player?.next?.title ?? "Next song",
    artist: player?.next?.artist ?? "",
    art: null,
  };

  /* ---------- swipe: the strip of three (previous, this, next) ---------- */
  const [w, setW] = useState(0);
  const x = useState(() => new Animated.Value(0))[0];
  const drag = useState(() => new Animated.Value(0))[0]; // the finger's travel
  const settle = (to: number, after?: () => void) =>
    Animated.spring(drag, {
      toValue: to,
      useNativeDriver: true,
      damping: 24,
      stiffness: 220,
      mass: 0.9,
      overshootClamping: !!after,
      restDisplacementThreshold: 0.5,
      restSpeedThreshold: 2,
    }).start(({ finished }) => finished && after?.());
  const change = (toNext: boolean) => {
    if (!player || !w) return;
    const song = toNext ? next : prev;
    settle(toNext ? -w : w, () => {
      onAction(player.id, toNext ? "next" : "previous");
      setShown(song.title === "Next song" || song.title === "Previous song" ? null : song);
      drag.setValue(0);
    });
  };
  const swipe = usePanGesture({
    runOnJS: true,
    enabled: !!player && w > 0,
    activeOffsetX: [-10, 10],
    failOffsetY: [-14, 14],
    onUpdate: (e) => {
      // Past the end of the queue it stretches instead.
      const dx = e.translationX;
      const stuck = (dx < 0 && player?.next === null) || (dx > 0 && player?.prev === null);
      drag.setValue(stuck ? dx / 3 : dx);
    },
    onDeactivate: (e) => {
      const dx = e.translationX;
      const far = Math.abs(dx) > w * 0.2 || Math.abs(e.velocityX) > 700;
      const stuck = (dx < 0 && player?.next === null) || (dx > 0 && player?.prev === null);
      if (far && !stuck) change(dx < 0);
      else settle(0);
    },
  });
  useEffect(() => x.setValue(-w), [w, x]);

  /* ---------- the record: turning by itself, and by hand to seek ----------
   * Everything here runs on the UI thread (Reanimated): the turn, the
   * rotation, the rim and the label. Nothing re-renders while you turn, so
   * the record and its cover stay perfectly smooth. */
  const spinDeg = useSharedValue(0); // turning by itself
  const baseDeg = useSharedValue(0); // where your hand left it
  const handDeg = useSharedValue(0); // the turn in progress
  const held = useSharedValue(0); // 1 while grabbed
  const lastA = useSharedValue(0);
  const grabPos = useSharedValue(0);
  const lenSV = useSharedValue(0);
  const tickSV = useSharedValue(0);
  const [grabbed, setGrabbed] = useState(false);
  useEffect(() => {
    lenSV.set(player?.length ?? 0);
  }, [player?.length, lenSV]);
  // Turns while it plays, from wherever it stopped (never back to 0: that jumped).
  useEffect(() => {
    if (!playing || grabbed || !motion) {
      cancelAnimation(spinDeg);
      return;
    }
    const from = spinDeg.get() % 360;
    spinDeg.set(from);
    spinDeg.set(withRepeat(withTiming(from + 360, { duration: 6000, easing: REasing.linear }), -1));
    return () => cancelAnimation(spinDeg);
  }, [playing, grabbed, motion, spinDeg]);

  // The JS side of a turn: haptics, pausing, seeking, resuming (a few calls per turn, never per frame).
  const wasPlaying = useRef(false);
  const onGrab = () => {
    const at = posNow() ?? 0;
    grabPos.set(at);
    wasPlaying.current = playing;
    seeking.current = true;
    setGrabbed(true);
    if (player && playing) onAction(player.id, "pause");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  };
  const onTick = () => void Haptics.selectionAsync().catch(() => undefined);
  const onRelease = (by: number) => {
    seeking.current = false;
    setGrabbed(false);
    if (!player) return;
    const g = grabPos.get();
    const to = Math.max(0, player.length ? Math.min(player.length, g + by) : g + by);
    if (Math.abs(by) > 500) onSeek(player.id, Math.round(to));
    // Play on from there, a moment after the seek.
    if (wasPlaying.current) setTimeout(() => onAction(player.id, "play"), 180);
  };

  const turn = usePanGesture({
    enabled: seekable,
    // Grabbed only after a hold; until then a slide is the tile's swipe.
    activateAfterLongPress: HOLD_MS,
    onActivate: (e) => {
      "worklet";
      lastA.set((Math.atan2(e.y - REC / 2, e.x - REC / 2) * 180) / Math.PI);
      handDeg.set(0);
      tickSV.set(0);
      cancelAnimation(spinDeg);
      cancelAnimation(progress);
      held.set(withSpring(1, { damping: 14 }));
      runOnJS(onGrab)();
    },
    onUpdate: (e) => {
      "worklet";
      const a = (Math.atan2(e.y - REC / 2, e.x - REC / 2) * 180) / Math.PI;
      let d = a - lastA.get();
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      lastA.set(a);
      handDeg.set(handDeg.get() + d);
      const by = (handDeg.get() / 360) * TURN_MS;
      // The rim shows where you'll land.
      if (lenSV.get() > 0)
        progress.set(Math.max(0, Math.min(1, (grabPos.get() + by) / lenSV.get())));
      // A light tick every 5 seconds turned, like a detent.
      const step = Math.trunc(by / 5000);
      if (step !== tickSV.get()) {
        tickSV.set(step);
        runOnJS(onTick)();
      }
    },
    onDeactivate: () => {
      "worklet";
      const by = Math.round((handDeg.get() / 360) * TURN_MS);
      // Keep the angle in the same frame, so letting go never snaps.
      baseDeg.set((baseDeg.get() + handDeg.get()) % 360);
      handDeg.set(0);
      held.set(withSpring(0, { damping: 16 }));
      runOnJS(onRelease)(by);
    },
  });
  const recordStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: 1 + 0.06 * held.get() },
      { rotate: `${spinDeg.get() + baseDeg.get() + handDeg.get()}deg` },
    ],
  }));

  // The label while you turn: "+0:12 · 1:34", drawn on the UI thread.
  const labelProps = useAnimatedProps(() => {
    const by = Math.round((handDeg.get() / 360) * TURN_MS);
    const len = lenSV.get();
    const to = Math.max(0, len > 0 ? Math.min(len, grabPos.get() + by) : grabPos.get() + by);
    const fmt = (ms: number) => {
      const t = Math.max(0, Math.round(Math.abs(ms) / 1000));
      const m = Math.floor(t / 60);
      const sec = t % 60;
      return `${m}:${sec < 10 ? "0" : ""}${sec}`;
    };
    const text =
      Math.abs(by) < 500 ? "Turn to seek" : `${by > 0 ? "+" : "−"}${fmt(by)}  ·  ${fmt(to)}`;
    return { text, defaultValue: text } as never;
  });
  const labelStyle = useAnimatedStyle(() => ({ opacity: held.get() }));

  const pane = (song: Song, live: boolean) => (
    <View style={[s.pane, { width: w || "100%" }]}>
      <View
        style={{ paddingTop: 14, paddingHorizontal: 14 }}
        accessible={live}
        accessibilityRole={live ? "adjustable" : undefined}
        accessibilityLabel={live ? `${song.title}, ${song.artist}` : undefined}
        accessibilityHint={
          live ? "Swipe the tile left for the next song, right for the previous one" : undefined
        }
        accessibilityActions={
          live
            ? [
                { name: "increment", label: "Next song" },
                { name: "decrement", label: "Previous song" },
              ]
            : undefined
        }
        onAccessibilityAction={(e) => change(e.nativeEvent.actionName === "increment")}
      >
        <Txt w="600" size={14.5} lines={1}>
          {song.title}
        </Txt>
        <Txt size={12.5} color={k.sub} lines={1}>
          {song.artist}
        </Txt>
      </View>

      {/* The rim: how far through the song. */}
      {live ? <Rim progress={progress} /> : null}

      {live ? (
        <GestureDetector gesture={turn}>
          <Reanimated.View
            style={[s.rec, recordStyle]}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="The record"
            accessibilityHint="Hold it, then turn it to seek. Adjust moves 10 seconds."
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => {
              const at = posNow();
              if (!player || at == null) return;
              const by = e.nativeEvent.actionName === "increment" ? 10_000 : -10_000;
              onSeek(player.id, Math.max(0, at + by));
            }}
          >
            <Record art={song.art} />
          </Reanimated.View>
        </GestureDetector>
      ) : (
        <View style={[s.rec, { opacity: 0.85 }]}>
          <Record art={song.art} />
        </View>
      )}

      {live ? (
        <Pressable
          onPress={() => player && onAction(player.id, "play-pause")}
          disabled={!player}
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause" : "Play"}
          hitSlop={6}
          style={({ pressed }) => [
            s.pp,
            { opacity: player ? 1 : 0.4, transform: [{ scale: pressed ? 0.92 : 1 }] },
          ]}
        >
          <Icon name={playing ? "pause" : "play"} size={18} color={k.ink} />
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <GestureDetector gesture={swipe}>
      <Tile
        style={{ flex: 1 }}
        onLayout={(e) => setW(e.nativeEvent.layout.width - 2)}
        accessible={false}
      >
        <Animated.View
          style={{
            flexDirection: "row",
            width: w * 3 || "300%",
            height: "100%",
            transform: [{ translateX: Animated.add(x, drag) }],
          }}
        >
          {pane(prev, false)}
          {pane(current, true)}
          {pane(next, false)}
        </Animated.View>
        <Reanimated.View style={[s.seek, labelStyle]} pointerEvents="none">
          <AnimatedInput
            editable={false}
            underlineColorAndroid="transparent"
            animatedProps={labelProps}
            style={s.seekText}
          />
        </Reanimated.View>
      </Tile>
    </GestureDetector>
  );
}

/**
 * The progress rim without SVG: a faint full ring, and a bright one revealed
 * by two half-rings turned on the UI thread (right half for the first half
 * of the song, left half for the second).
 */
function Rim({ progress }: { progress: SharedValue<number> }) {
  const first = useAnimatedStyle(() => ({
    transform: [{ rotate: `${Math.min(progress.get(), 0.5) * 360}deg` }],
  }));
  const second = useAnimatedStyle(() => ({
    transform: [{ rotate: `${Math.max(progress.get() - 0.5, 0) * 360}deg` }],
    opacity: progress.get() > 0.5 ? 1 : 0,
  }));
  return (
    <View style={s.arc} pointerEvents="none">
      <View style={[s.ring, { borderColor: "rgba(239,231,220,0.1)" }]} />
      {/* The right half of the circle shows the left half-ring turned by up to 180°. */}
      <View style={[s.clip, { left: ARC / 2 }]}>
        <Reanimated.View
          style={[s.half, { left: -ARC / 2, transformOrigin: "right center" }, first]}
        >
          <View style={[s.ring, { left: 0 }]} />
        </Reanimated.View>
      </View>
      {/* The left half shows the right half-ring turned by up to 180°. */}
      <View style={[s.clip, { left: 0 }]}>
        <Reanimated.View
          style={[s.half, { left: ARC / 2, transformOrigin: "left center" }, second]}
        >
          <View style={[s.ring, { left: -ARC / 2 }]} />
        </Reanimated.View>
      </View>
    </View>
  );
}

/**
 * A record: grooves, the cover as its label, the hole. Memoized with a fixed
 * image source, so the cover never reloads (or flickers) unless it changes.
 */
const Record = memo(function Record({ art }: { art: string | null }) {
  const source = useMemo(() => (art ? { uri: art } : null), [art]);
  return (
    <View style={s.vinyl}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <View
          key={i}
          style={[
            s.groove,
            {
              margin: 8 + i * 7,
              borderColor: i % 2 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.35)",
            },
          ]}
        />
      ))}
      <View style={s.label}>
        {source ? (
          <Image
            source={source}
            style={StyleSheet.absoluteFill}
            fadeDuration={0}
            resizeMethod="resize"
          />
        ) : (
          <LinearGradient
            colors={[...NO_COVER]}
            locations={[0, 0.35, 0.7, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={s.hole} />
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  pane: { height: "100%", overflow: "hidden" },
  rec: { position: "absolute", width: REC, height: REC, right: -34, bottom: -40 },
  arc: { position: "absolute", right: -40, bottom: -46, width: ARC, height: ARC },
  ring: {
    position: "absolute",
    top: 0,
    width: ARC,
    height: ARC,
    borderRadius: ARC / 2,
    borderWidth: RING,
    borderColor: k.brass2,
  },
  clip: { position: "absolute", top: 0, width: ARC / 2, height: ARC, overflow: "hidden" },
  half: { position: "absolute", top: 0, width: ARC / 2, height: ARC, overflow: "hidden" },
  vinyl: {
    width: REC,
    height: REC,
    borderRadius: REC / 2,
    backgroundColor: "#17131c",
    alignItems: "center",
    justifyContent: "center",
    elevation: 12,
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
  },
  groove: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: REC,
    borderWidth: 1,
  },
  label: {
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  hole: { width: 8, height: 8, borderRadius: 4, backgroundColor: k.bg },
  pp: {
    position: "absolute",
    left: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 99,
    backgroundColor: k.text,
    alignItems: "center",
    justifyContent: "center",
  },
  seek: {
    position: "absolute",
    left: 12,
    top: 52,
    backgroundColor: k.text,
    paddingHorizontal: 10,
    borderRadius: 99,
  },
  seekText: {
    color: k.ink,
    fontFamily: font.semi,
    fontSize: 13,
    padding: 0,
    paddingVertical: 4,
    minWidth: 90,
    includeFontPadding: false,
  },
});
