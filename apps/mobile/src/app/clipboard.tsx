/**
 * Both clipboards side by side: the phone's and the laptop's. Put either on
 * the other side (to paste it there), and keep them in one, both ways.
 */
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { clip } from "../core/clip";
import { errorText } from "../ui/errors";
import { Icon, type IconName } from "../ui/icon";
import { Btn, Item, Sheet, Toggle, Txt, toast } from "../ui/lac";
import { useApp, useLaptop, useLink, usePoll } from "../ui/state";
import { k } from "../ui/theme";

export default function ClipboardScreen() {
  const { session } = useApp();
  const link = useLink();
  const laptop = useLaptop();
  const name = laptop?.name ?? "the laptop";
  const client = link.status === "online" ? session?.link.client : null;
  // The laptop's is read when you open this and after each change (each read is logged there).
  const theirs = usePoll(() => client?.clipboard.get.query() ?? null, [client], 120_000);
  const sync = usePoll(() => client?.clipboard.sync.get.query() ?? null, [client], 5000);
  const [mine, setMine] = useState<string>("");

  const readMine = useCallback(() => void Clipboard.getStringAsync().then(setMine), []);
  useEffect(() => {
    readMine();
    const sub = Clipboard.addClipboardListener(readMine);
    const app = AppState.addEventListener("change", (s) => s === "active" && readMine());
    return () => {
      sub.remove();
      app.remove();
    };
  }, [readMine]);

  const say = (text: string, _bad = false) => toast(text);
  const toLaptop = async () => {
    if (!client || !mine) return;
    clip.sent = mine;
    await client.clipboard.set
      .mutate({ text: mine })
      .then(() => {
        theirs.reload();
        say(`On ${name}'s clipboard: paste it there`);
      })
      .catch((e: unknown) => say(errorText(e), true));
  };
  const toPhone = async () => {
    const t = theirs.data;
    if (!t) return;
    clip.heard = t;
    await Clipboard.setStringAsync(t);
    readMine();
    say("On this phone's clipboard: paste it anywhere");
  };
  const setSync = async (on: boolean) => {
    if (!client) return;
    await client.clipboard.sync.set
      .mutate({ on })
      .then(() => {
        sync.reload();
        if (on) setTimeout(() => readMine(), 1500);
      })
      .catch((e: unknown) => say(errorText(e), true));
  };

  const same = !!mine && mine === theirs.data;

  return (
    <Sheet title="Clipboard">
      {!client ? (
        <Txt size={14} color={k.sub} style={{ marginBottom: 12 }}>
          Not connected: {name}'s clipboard shows up when the phone reaches it.
        </Txt>
      ) : null}

      <Board
        icon="phone"
        title="This phone"
        text={mine}
        action={{
          label: `Put on ${name}`,
          kind: "solid",
          onPress: () => void toLaptop(),
          disabled: !client || !mine || same,
        }}
      />
      <Board
        icon="laptop"
        title={name}
        text={client ? (theirs.data ?? (theirs.error ? "" : null)) : ""}
        error={theirs.error}
        action={{
          label: "Copy to this phone",
          kind: "plain",
          onPress: () => void toPhone(),
          disabled: !theirs.data || same,
        }}
        onRefresh={client ? () => theirs.reload() : undefined}
      />
      {same ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginBottom: 6,
            marginLeft: 2,
          }}
        >
          <Icon name="check" size={15} color={k.sage} />
          <Txt size={13} color={k.sage}>
            Both clipboards hold the same
          </Txt>
        </View>
      ) : null}

      <Item
        style={{ paddingHorizontal: 2, paddingVertical: 6 }}
        title="Keep both in sync"
        sub="What you copy on either side lands on the other"
        subLines={2}
        label="Keep both clipboards in sync"
        onPress={client ? () => void setSync(!sync.data) : undefined}
        right={
          <Toggle
            on={sync.data ?? false}
            onChange={(v) => void setSync(v)}
            disabled={!client}
            label="Keep both clipboards in sync"
          />
        }
      />
    </Sheet>
  );
}

function Board({
  icon,
  title,
  text,
  error,
  action,
  onRefresh,
}: {
  icon: IconName;
  title: string;
  text: string | null;
  error?: string | null;
  action: { label: string; kind: "solid" | "plain"; onPress: () => void; disabled: boolean };
  onRefresh?: () => void;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: k.line,
        borderRadius: 20,
        padding: 14,
        marginBottom: 12,
        backgroundColor: k.ink,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Icon name={icon} color={k.text} />
        <Txt w="600" style={{ flex: 1 }} lines={1}>
          {title}
        </Txt>
        {onRefresh ? (
          <Pressable
            onPress={onRefresh}
            accessibilityRole="button"
            accessibilityLabel="Read it again"
            hitSlop={10}
          >
            <Icon name="refresh" color={k.mute} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ minHeight: 42 }}>
        {error ? (
          <Txt size={14.5} color={k.rose}>
            {error}
          </Txt>
        ) : text === null ? (
          <Txt size={14.5} color={k.mute}>
            Reading…
          </Txt>
        ) : text ? (
          <Txt size={14.5} lines={6} style={{ lineHeight: 21 }}>
            {text}
          </Txt>
        ) : (
          <Txt size={14.5} color={k.mute}>
            Empty
          </Txt>
        )}
      </View>
      <Btn
        label={action.label}
        kind={action.kind}
        onPress={action.onPress}
        disabled={action.disabled}
      />
    </View>
  );
}
