/**
 * The laptop's trackpad and keyboard. One finger moves the pointer (tap:
 * click); two fingers scroll (tap: right click). Text typed below goes to
 * the laptop with the right layout; the keys row sends Esc, Tab, arrows…
 */
import { useEffect, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  PanResponder,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Navbar, Txt } from "../ui/lac";
import { useApp, useLink } from "../ui/state";
import { font, k } from "../ui/theme";

/** Pointer speed: laptop pixels per phone point. */
const SPEED = 1.6;
/** Points of two-finger travel per wheel notch. */
const NOTCH = 18;
/**
 * A touch that moves less than this and ends quickly is a tap. Two fingers
 * land and lift a moment apart, so their tap gets more room.
 */
const TAP = { 1: { slop: 10, ms: 250 }, 2: { slop: 30, ms: 400 } } as const;

/** The keys a phone keyboard lacks, as they wrap under the buttons. */
const KEYS: { label: string; combo: string; a11y: string }[] = [
  { label: "esc", combo: "Escape", a11y: "Escape" },
  { label: "tab", combo: "Tab", a11y: "Tab" },
  { label: "super", combo: "super", a11y: "Super" },
  { label: "↑", combo: "Up", a11y: "Up" },
  { label: "⌫", combo: "BackSpace", a11y: "Backspace" },
  { label: "⏎", combo: "Return", a11y: "Return" },
  { label: "copy", combo: "ctrl+c", a11y: "Copy" },
  { label: "paste", combo: "ctrl+v", a11y: "Paste" },
  { label: "←", combo: "Left", a11y: "Left" },
  { label: "↓", combo: "Down", a11y: "Down" },
  { label: "→", combo: "Right", a11y: "Right" },
  { label: "alt-tab", combo: "alt+Tab", a11y: "Alt Tab" },
];

/** The trackpad's buttons: wide left and right, a narrow middle, as on a laptop. */
const BUTTONS = [
  { button: "left", label: "Left", flex: 2 },
  { button: "middle", label: "Middle", flex: 1 },
  { button: "right", label: "Right", flex: 2 },
] as const;

/** What the pad reports out of its gestures (all called from touch handlers, never in render). */
interface PadOut {
  fail: (e: unknown) => void;
  dot: Animated.ValueXY;
  shown: Animated.Value;
}
type Api = NonNullable<NonNullable<ReturnType<typeof useApp>["session"]>["link"]["client"]>;

/**
 * The trackpad's gestures, outside React (its state lives in this closure, not
 * in renders): one finger moves, two scroll, a quick touch clicks. Moves add up
 * and go at most every 16 ms, only while a finger is down; the laptop adds up
 * what's still in flight. The finger's circle moves with an Animated value.
 */
function makePad(out: PadOut) {
  /** The laptop to send to; set by the screen as the link comes and goes. */
  let client: Api | null = null;
  const api = () => client;
  let last = { x: 0, y: 0 };
  /** The most fingers down at once in this gesture (decides left or right click). */
  let fingers = 1;
  /** Fingers down right now. */
  let active = 1;
  let start = 0;
  let travel = 0;
  const pending = { dx: 0, dy: 0, scroll: 0 };
  let sender: ReturnType<typeof setInterval> | null = null;
  const flush = () => {
    const a = api();
    if (!a) return;
    if (Math.abs(pending.dx) >= 1 || Math.abs(pending.dy) >= 1) {
      const dx = Math.round(pending.dx);
      const dy = Math.round(pending.dy);
      pending.dx -= dx;
      pending.dy -= dy;
      void a.input.move.mutate({ dx, dy }).catch(out.fail);
    }
    const notches = Math.trunc(pending.scroll / NOTCH);
    if (notches) {
      pending.scroll -= notches * NOTCH;
      void a.input.scroll
        .mutate({ dx: 0, dy: Math.max(-100, Math.min(100, notches)) })
        .catch(out.fail);
    }
  };
  const mid = (touches: readonly { pageX: number; pageY: number }[]) => ({
    x: touches.reduce((s, t) => s + t.pageX, 0) / Math.max(1, touches.length),
    y: touches.reduce((s, t) => s + t.pageY, 0) / Math.max(1, touches.length),
  });
  const show = (x: number, y: number) => {
    out.dot.setValue({ x: x - 23, y: y - 23 });
    out.shown.setValue(1);
  };
  const end = () => {
    out.shown.setValue(0);
    flush();
    if (sender) clearInterval(sender);
    sender = null;
    const a = api();
    const two = fingers >= 2;
    const t = TAP[two ? 2 : 1];
    if (!a || travel > t.slop || Date.now() - start > t.ms) return;
    // A two-finger tap may have started a little scroll: drop it.
    if (two) pending.scroll = 0;
    void a.input.click.mutate({ button: two ? "right" : "left", double: false }).catch(out.fail);
  };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      last = mid(e.nativeEvent.touches);
      show(e.nativeEvent.locationX, e.nativeEvent.locationY);
      fingers = active = Math.max(1, e.nativeEvent.touches.length);
      start = Date.now();
      travel = 0;
      if (!sender) sender = setInterval(flush, 16);
    },
    // Every finger that lands, even one that never moves (a clean two-finger tap):
    // counting fingers only on moves turned that tap into a left click.
    onPanResponderStart: (e) => {
      const n = e.nativeEvent.touches.length;
      fingers = Math.max(fingers, n);
      active = n;
      last = mid(e.nativeEvent.touches);
    },
    onPanResponderEnd: (e) => {
      active = e.nativeEvent.touches.length;
      if (active) last = mid(e.nativeEvent.touches);
    },
    onPanResponderMove: (e) => {
      const touches = e.nativeEvent.touches;
      const now = mid(touches);
      if (touches.length !== active) {
        // A finger came or went: start from here, no jump.
        fingers = Math.max(fingers, touches.length);
        active = touches.length;
        last = now;
        return;
      }
      const dx = now.x - last.x;
      const dy = now.y - last.y;
      last = now;
      show(e.nativeEvent.locationX, e.nativeEvent.locationY);
      travel += Math.abs(dx) + Math.abs(dy);
      if (touches.length >= 2) pending.scroll += dy;
      else {
        pending.dx += dx * SPEED;
        pending.dy += dy * SPEED;
      }
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: end,
    onPanResponderTerminate: end,
  });
  return {
    handlers: responder.panHandlers,
    setApi: (c: Api | null) => {
      client = c;
    },
    stop: () => {
      if (sender) clearInterval(sender);
      sender = null;
    },
  };
}

export default function Trackpad() {
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const fail = (e: unknown) => setError(errorText(e));
  const [dot] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const [shown] = useState(() => new Animated.Value(0));
  const [pad] = useState(() =>
    makePad({
      fail: (e) => setError(errorText(e)),
      dot,
      shown,
    }),
  );
  // The pad reads the laptop when a touch needs it: hand it the latest, after render.
  useEffect(() => pad.setApi(client ?? null), [pad, client]);
  useEffect(() => () => pad.stop(), [pad]);

  const press = (combo: string) => void client?.input.key.mutate({ combo }).catch(fail);
  const send = () => {
    if (!text) return;
    void client?.input.type.mutate({ text }).then(() => setText(""), fail);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.ink }} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
          <Navbar back="Home" mid="Trackpad" />
          {!client || error ? (
            <Pressable onPress={() => setError(null)} style={{ marginBottom: 10 }}>
              <Txt size={13} color={k.rose}>
                {!client
                  ? "Not connected to the laptop."
                  : /may not use|input/.test(error ?? "")
                    ? "This phone may not use the laptop's keyboard and pointer: allow “Keyboard and pointer” for it in the laptop's ekatva window."
                    : error}
              </Txt>
            </Pressable>
          ) : null}
          <View
            {...pad.handlers}
            accessibilityLabel="Trackpad: one finger moves, tap to click; two fingers scroll, tap to right-click"
            style={{
              flex: 1,
              minHeight: 160,
              borderRadius: 28,
              borderWidth: 1,
              borderColor: k.line,
              overflow: "hidden",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* A native gradient, not an SVG (that was a pad-sized bitmap). */}
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  experimental_backgroundImage:
                    "radial-gradient(circle at 50% 30%, #221c29 0%, #17131c 70%)",
                },
              ]}
            />
            <Txt size={13.5} color={k.mute} align="center" style={{ lineHeight: 23 }}>
              {"One finger moves, tap to click\nTwo fingers scroll, tap to right-click"}
            </Txt>
            <Animated.View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: 46,
                height: 46,
                borderRadius: 99,
                backgroundColor: `${k.brass}40`,
                opacity: shown,
                transform: dot.getTranslateTransform(),
              }}
            />
          </View>

          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            {BUTTONS.map((b) => (
              <Pressable
                key={b.button}
                onPress={() =>
                  void client?.input.click.mutate({ button: b.button, double: false }).catch(fail)
                }
                accessibilityRole="button"
                accessibilityLabel={`${b.label} click`}
                style={({ pressed }) => ({
                  flex: b.flex,
                  paddingVertical: 13,
                  alignItems: "center",
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: k.line2,
                  backgroundColor: pressed ? k.plum : k.ink2,
                })}
              >
                <Txt w="500">{b.label}</Txt>
              </Pressable>
            ))}
          </View>

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 10,
              marginBottom: 8,
            }}
          >
            {KEYS.map((key) => (
              <Pressable
                key={key.combo}
                onPress={() => press(key.combo)}
                accessibilityRole="button"
                accessibilityLabel={key.a11y}
                style={({ pressed }) => ({
                  minWidth: 44,
                  height: 38,
                  paddingHorizontal: 10,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: k.line2,
                  backgroundColor: pressed ? k.plum : k.ink2,
                })}
              >
                <Txt mono size={13}>
                  {key.label}
                </Txt>
              </Pressable>
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={send}
              placeholder="Type on the laptop"
              placeholderTextColor={k.mute}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              // Grows with what you type (up to about six lines, then it scrolls), so you see
              // all of it, not only its tail; Enter still sends.
              multiline
              submitBehavior="submit"
              style={{
                flex: 1,
                maxHeight: 140,
                minHeight: 46,
                textAlignVertical: "center",
                color: k.text,
                fontFamily: font.body,
                fontSize: 15,
                backgroundColor: k.ink2,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: k.line2,
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            />
            <Pressable
              onPress={send}
              disabled={!text}
              accessibilityRole="button"
              accessibilityLabel="Type it on the laptop"
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 999,
                backgroundColor: k.text,
                alignItems: "center",
                justifyContent: "center",
                opacity: !text ? 0.5 : pressed ? 0.8 : 1,
              })}
            >
              <Icon name="up" size={20} color={k.ink} />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
