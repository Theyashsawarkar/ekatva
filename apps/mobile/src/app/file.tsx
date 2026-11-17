import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { errorText } from "../ui/errors";
import { Btn, Navbar, Page, Panel, Txt } from "../ui/lac";
import { useApp, useLink } from "../ui/state";
import { k } from "../ui/theme";
import { downloadToPhone, fetchFile, size } from "../ui/transfer";

const PREVIEW = 512 * 1024;

/** A quick look at a laptop file: text or an image; anything else, download. */
export default function FilePreview() {
  const p = useLocalSearchParams<{ path: string; name: string; size: string; mime: string }>();
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bytes = Number(p.size);
  const isImage = p.mime?.startsWith("image/") && p.mime !== "image/svg+xml";
  const isText = !p.mime || p.mime.startsWith("text/") || /json|xml|javascript|svg/.test(p.mime);

  useEffect(() => {
    if (!client) return;
    if (isImage && bytes < 20 * 1024 * 1024) {
      fetchFile(client, p.path, p.name).then(
        (f) => setImage(f.uri),
        (e: unknown) => setError(errorText(e)),
      );
    } else if (isText) {
      client.files.read.query({ path: p.path, offset: 0, length: PREVIEW }).then(
        (r) => {
          const bin = atob(r.data);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          setText(new TextDecoder().decode(arr) + (r.eof ? "" : "\n\n… (first 512 kB)"));
        },
        (e: unknown) => setError(errorText(e)),
      );
    }
  }, [client, p.path, p.name, isImage, isText, bytes]);

  return (
    <Page scroll={false} bottom={24}>
      <Navbar back="Files" mid={p.name} />
      <Txt size={13} color={k.sub} lines={1} style={{ marginBottom: 12 }}>
        {p.path} · {size(bytes)}
      </Txt>
      {error ? (
        <Txt size={14} color={k.rose} style={{ marginBottom: 12 }}>
          {error}
        </Txt>
      ) : null}
      {image ? (
        // Decoded at the screen's size (it's a file: uri), not the photo's: a
        // 4000×3000 photo would otherwise take ~48 MB of memory.
        <Image
          source={{ uri: image }}
          style={{ flex: 1, borderRadius: 20 }}
          resizeMode="contain"
          resizeMethod="resize"
        />
      ) : null}
      {text !== null ? (
        <ScrollView
          style={{
            flex: 1,
            backgroundColor: k.term,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: k.line,
          }}
          contentContainerStyle={{ padding: 12 }}
        >
          <Txt mono size={12.5} color="#e6dfd5" style={{ lineHeight: 19.4 }}>
            {text}
          </Txt>
        </ScrollView>
      ) : null}
      {!isImage && !isText ? (
        <Panel style={{ padding: 16 }}>
          <Txt size={14} color={k.sub}>
            No preview for this kind of file.
          </Txt>
        </Panel>
      ) : null}
      {(isImage && !image) || (isText && text === null) ? <View style={{ flex: 1 }} /> : null}
      <Btn
        label="Download to the phone"
        icon="download"
        kind="solid"
        disabled={!client}
        onPress={() =>
          client &&
          void downloadToPhone(client, {
            name: p.name,
            path: p.path,
            kind: "file",
            size: bytes,
            mtime: 0,
            ...(p.mime ? { mime: p.mime } : {}),
          })
        }
      />
    </Page>
  );
}
