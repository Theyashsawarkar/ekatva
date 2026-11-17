/**
 * The terminal's dock, under the screen: one row of the keys a phone lacks
 * (esc, tab, ctrl, alt, ^C, the arrows), the command field with Return inside
 * it, and a tray (the + key) with symbols, more keys and tmux's own.
 * Ctrl and Alt stay held (ember) until the next key or command.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, TextInput, View, type ViewStyle } from "react-native";
import { Icon, type IconName } from "../icon";
import { Txt } from "../lac";
import { font, k } from "../theme";

export type DockAction =
  | { keys: string[] }
  | { text: string }
  | { tmux: "split" | "scroll" }
  | { line: string };

const SYMBOLS = ["~", "/", "|", "-", "_", ":", "*", ".", ">", "&", "$", '"'];
const MORE_KEYS: { label: string; keys: string[] }[] = [
  { label: "^D", keys: ["C-d"] },
  { label: "^Z", keys: ["C-z"] },
  { label: "^L", keys: ["C-l"] },
  { label: "^R", keys: ["C-r"] },
  { label: "home", keys: ["Home"] },
  { label: "end", keys: ["End"] },
];

export function Dock({ onAction }: { onAction: (a: DockAction) => void }) {
  const [more, setMore] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [line, setLine] = useState("");
  const [focused, setFocused] = useState(false);
  const [trayH, setTrayH] = useState(0);
  const open = useState(() => new Animated.Value(0))[0];
  const input = useRef<{ focus(): void } | null>(null);

  useEffect(() => {
    Animated.timing(open, {
      toValue: more ? 1 : 0,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [more, open]);

  /** A key, with Ctrl or Alt if held (then let go). */
  const press = (key: string) => {
    const mod = ctrl ? "C-" : alt ? "M-" : "";
    const named = /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
    onAction({ keys: [mod && /^[a-z0-9]$/.test(named) ? `${mod}${named}` : key] });
    setCtrl(false);
    setAlt(false);
  };
  const submit = () => {
    if ((ctrl || alt) && line.length === 1) press(line);
    else if (line) onAction({ line });
    else onAction({ keys: ["Enter"] });
    setLine("");
    setCtrl(false);
    setAlt(false);
  };
  const insert = (c: string) => {
    setLine((l) => l + c);
    input.current?.focus();
  };

  const height = open.interpolate({ inputRange: [0, 1], outputRange: [0, trayH] });
  const turn = open.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "45deg"] });

  return (
    <View
      style={{
        marginTop: 10,
        padding: 8,
        borderRadius: 24,
        backgroundColor: k.ink2,
        borderWidth: 1,
        borderColor: k.line,
        gap: 8,
      }}
      accessibilityLabel="Terminal keys"
    >
      <Animated.View style={{ height, overflow: "hidden" }}>
        <View
          onLayout={(e) => setTrayH(e.nativeEvent.layout.height)}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            gap: 10,
            paddingTop: 4,
            paddingHorizontal: 2,
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderColor: k.line,
          }}
        >
          <View>
            <Head>Symbols</Head>
            <Grid>
              {SYMBOLS.map((c) => (
                <Chip key={c} label={c} sym onPress={() => insert(c)} />
              ))}
            </Grid>
          </View>
          <View>
            <Head>Keys</Head>
            <Grid>
              {MORE_KEYS.map((m) => (
                <Chip key={m.label} label={m.label} onPress={() => onAction({ keys: m.keys })} />
              ))}
            </Grid>
          </View>
          <View>
            <Head>tmux</Head>
            <Grid cols={3}>
              <Chip
                label="prefix"
                icon="term"
                tmux
                onPress={() => onAction({ keys: ["Prefix"] })}
                a11y="tmux prefix, then a key"
              />
              <Chip
                label="split"
                icon="plus"
                tmux
                onPress={() => onAction({ tmux: "split" })}
                a11y="Split the window"
              />
              <Chip
                label="scroll"
                icon="up"
                tmux
                onPress={() => onAction({ tmux: "scroll" })}
                a11y="Scroll back (copy mode)"
              />
            </Grid>
          </View>
        </View>
      </Animated.View>

      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <Key label="esc" onPress={() => press("Escape")} />
        <Key label="tab" onPress={() => press("Tab")} />
        <Key
          label="ctrl"
          on={ctrl}
          onPress={() => {
            setCtrl(!ctrl);
            setAlt(false);
          }}
        />
        <Key
          label="alt"
          on={alt}
          onPress={() => {
            setAlt(!alt);
            setCtrl(false);
          }}
        />
        <Key label="^C" hot onPress={() => onAction({ keys: ["C-c"] })} a11y="Ctrl C, stop" />
        <View
          style={{
            flex: 2.3,
            flexDirection: "row",
            height: 38,
            borderRadius: 12,
            backgroundColor: k.plum,
            borderWidth: 1,
            borderColor: k.line2,
          }}
          accessibilityLabel="Arrow keys"
        >
          {(
            [
              ["left", "Left"],
              ["up", "Up"],
              ["down", "Down"],
              ["right", "Right"],
            ] as const
          ).map(([icon, key]) => (
            <Key
              key={key}
              icon={icon}
              a11y={key}
              onPress={() => press(key)}
              style={{ height: 36, borderRadius: 11 }}
              color={k.text}
            />
          ))}
        </View>
        <Pressable
          onPress={() => setMore(!more)}
          accessibilityRole="button"
          accessibilityLabel="More keys"
          accessibilityState={{ expanded: more }}
          style={({ pressed }) => [
            keyStyle,
            {
              backgroundColor: more ? k.plum2 : pressed ? k.plum : "transparent",
              transform: [{ scale: pressed ? 0.94 : 1 }],
            },
          ]}
        >
          <Animated.View style={{ transform: [{ rotate: turn }] }}>
            <Icon name="plus" size={17} color={more ? k.text : k.sub} />
          </Animated.View>
        </Pressable>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: k.term,
          borderWidth: 1,
          borderColor: focused ? `${k.sage}8c` : k.line2,
          borderRadius: 18,
          paddingLeft: 14,
          paddingRight: 5,
          height: 50,
        }}
      >
        <Txt mono size={14} color={ctrl || alt ? k.ember : k.sage}>
          {ctrl ? "^" : alt ? "⌥" : "❯"}
        </Txt>
        <TextInput
          ref={input as never}
          value={line}
          onChangeText={setLine}
          onSubmitEditing={submit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={ctrl ? "A letter, with Ctrl" : alt ? "A letter, with Alt" : "Type a command"}
          placeholderTextColor={k.mute}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="send"
          submitBehavior="submit"
          style={{
            flex: 1,
            minWidth: 0,
            color: k.text,
            fontFamily: font.mono,
            fontSize: 14,
            paddingVertical: 0,
          }}
        />
        <Pressable
          onPress={submit}
          accessibilityRole="button"
          accessibilityLabel="Return"
          hitSlop={6}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            borderRadius: 14,
            backgroundColor: k.sage,
            alignItems: "center",
            justifyContent: "center",
            transform: [{ scale: pressed ? 0.92 : 1 }],
          })}
        >
          <Icon name="enter" size={18} color={k.onSage} />
        </Pressable>
      </View>
    </View>
  );
}

const keyStyle: ViewStyle = {
  flex: 1,
  minWidth: 0,
  height: 38,
  borderRadius: 12,
  alignItems: "center",
  justifyContent: "center",
};

function Key({
  label,
  icon,
  on,
  hot,
  onPress,
  a11y,
  style,
  color,
}: {
  label?: string;
  icon?: IconName;
  on?: boolean;
  hot?: boolean;
  onPress: () => void;
  a11y?: string;
  style?: ViewStyle;
  color?: string;
}) {
  const fg = on ? k.onEmber : hot ? k.rose : (color ?? k.sub);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={on !== undefined ? { selected: on } : undefined}
      style={({ pressed }) => [
        keyStyle,
        {
          backgroundColor: on ? k.ember : pressed ? k.plum2 : "transparent",
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        style,
      ]}
    >
      {icon ? (
        <Icon name={icon} size={17} color={fg} />
      ) : (
        <Txt size={13} w="500" color={fg}>
          {label}
        </Txt>
      )}
    </Pressable>
  );
}

function Head({ children }: { children: string }) {
  return (
    <Txt size={12} w="500" color={k.mute} style={{ marginBottom: 6, marginLeft: 4 }}>
      {children}
    </Txt>
  );
}

/** Equal columns, 6 apart. */
function Grid({ children, cols = 6 }: { children: React.ReactNode[]; cols?: number }) {
  const rows: React.ReactNode[][] = [];
  children.forEach((c, i) => {
    if (i % cols === 0) rows.push([]);
    rows.at(-1)?.push(c);
  });
  return (
    <View style={{ gap: 6 }}>
      {rows.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed grid
        <View key={r} style={{ flexDirection: "row", gap: 6 }}>
          {row}
        </View>
      ))}
    </View>
  );
}

function Chip({
  label,
  icon,
  sym,
  tmux,
  onPress,
  a11y,
}: {
  label: string;
  icon?: IconName;
  sym?: boolean;
  tmux?: boolean;
  onPress: () => void;
  a11y?: string;
}) {
  const fg = tmux ? k.sage : k.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        height: 36,
        borderRadius: 12,
        flexDirection: "row",
        gap: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? k.plum2 : k.plum,
        borderWidth: 1,
        borderColor: k.line,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Txt mono={sym} size={sym ? 15 : tmux ? 12.5 : 13} w="500" color={fg}>
        {label}
      </Txt>
    </Pressable>
  );
}
