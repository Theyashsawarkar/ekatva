/**
 * Send to the laptop: files (into its Downloads), a link (opens in its
 * browser), text (its clipboard). Opened from Home, or by "Share → ekatva"
 * in any app with what was shared.
 */
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { Shared } from "../../modules/ekatva-phone";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Btn, Item, List, Sheet, Txt } from "../ui/lac";
import { pickDocuments } from "../ui/pick";
import { sendFile, sendText } from "../ui/send";
import { useApp, useLaptop, useLink } from "../ui/state";
import { font, k } from "../ui/theme";
import { size } from "../ui/transfer";

/** What another app shared into ekatva, if anything (and only if it reads). */
function parseShared(raw: string | undefined): Shared | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Shared;
  } catch {
    return null;
  }
}

export default function Send() {
  const { session } = useApp();
  const link = useLink();
  const laptop = useLaptop();
  const client = link.status === "online" ? session?.link.client : null;
  const params = useLocalSearchParams<{ shared?: string }>();
  const shared = parseShared(params.shared);
  const [text, setText] = useState(shared?.text ?? "");
  const [files, setFiles] = useState(shared?.files ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(!!shared?.text);
  const name = laptop?.name ?? "the laptop";

  const pick = async () => {
    const r = await pickDocuments(true);
    if (r.canceled) return;
    setFiles((f) => [
      ...f,
      ...r.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? 0 })),
    ]);
  };

  const send = async () => {
    if (!client) return;
    setError(null);
    const sendAll = async () => {
      for (const f of files) {
        setBusy(`${f.name}: 0%`);
        await sendFile(client, f.uri, f.name, (p) => setBusy(`${f.name}: ${Math.round(p * 100)}%`));
        setDone((d) => [...d, `${f.name} → Downloads`]);
      }
      setFiles([]);
      const t = text.trim();
      if (t) {
        setBusy("Sending the text");
        const r = await sendText(client, t);
        setDone((d) => [...d, r]);
        setText("");
      }
    };
    await sendAll()
      .catch((e: unknown) => {
        const m = errorText(e);
        setError(
          /may not use/.test(m)
            ? "This phone may not send to the laptop: allow “Send files and links” for it in the laptop's ekatva window."
            : m,
        );
      })
      .finally(() => setBusy(null));
  };

  return (
    <Sheet title={`Send to ${name}`}>
      {!client ? (
        <Txt size={14} color={k.amber} style={{ marginBottom: 12 }}>
          Not connected to {name}: send once it's back.
        </Txt>
      ) : null}
      <List>
        <Item
          glyph="doc"
          title="Files"
          sub={`They land in Downloads on ${name}`}
          chev
          onPress={() => void pick()}
        />
        <Item
          glyph="send"
          title="A link or text"
          sub="Links open in the browser, text goes on the clipboard"
          subLines={2}
          chev
          onPress={() => setWriting(true)}
        />
      </List>

      {files.length ? (
        <List inset={16} style={{ marginTop: 12 }}>
          {files.map((f) => (
            <Item
              key={f.uri}
              title={f.name}
              sub={size(f.size)}
              right={
                <Pressable
                  onPress={() => setFiles((all) => all.filter((x) => x.uri !== f.uri))}
                  accessibilityRole="button"
                  accessibilityLabel={`Leave out ${f.name}`}
                  hitSlop={10}
                >
                  <Icon name="close" size={18} color={k.mute} />
                </Pressable>
              }
            />
          ))}
        </List>
      ) : null}

      {writing ? (
        <View style={{ marginTop: 12 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus={!shared?.text}
            multiline
            autoCapitalize="none"
            placeholder="https://… opens there; other text goes on its clipboard"
            placeholderTextColor={k.mute}
            style={{
              backgroundColor: k.ink,
              borderWidth: 1,
              borderColor: k.line2,
              borderRadius: 14,
              paddingHorizontal: 14,
              paddingVertical: 12,
              minHeight: 84,
              color: k.text,
              fontFamily: font.body,
              fontSize: 15,
              textAlignVertical: "top",
            }}
          />
          <Pressable
            onPress={() => void Clipboard.getStringAsync().then((t) => setText(t))}
            accessibilityRole="button"
            hitSlop={8}
            style={{
              alignSelf: "flex-start",
              marginTop: 10,
              flexDirection: "row",
              gap: 6,
              alignItems: "center",
            }}
          >
            <Icon name="clip" size={16} color={k.brass2} />
            <Txt size={14} color={k.brass2}>
              Paste this phone's clipboard
            </Txt>
          </Pressable>
        </View>
      ) : null}

      {error ? (
        <Txt size={14} color={k.rose} style={{ marginTop: 12, lineHeight: 20 }}>
          {error}
        </Txt>
      ) : null}
      {done.map((d) => (
        <View key={d} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
          <Icon name="check" size={15} color={k.sage} />
          <Txt size={14} color={k.sage} style={{ flex: 1 }}>
            {d}
          </Txt>
        </View>
      ))}
      {files.length || text.trim() || busy ? (
        <Btn
          label={busy ?? "Send"}
          kind="solid"
          disabled={!client || busy !== null || (!files.length && !text.trim())}
          onPress={() => void send()}
        />
      ) : null}
    </Sheet>
  );
}
