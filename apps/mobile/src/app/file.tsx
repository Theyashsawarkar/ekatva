import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image, ScrollView } from "react-native";
import { Button, Card, Screen, s, T } from "../ui/kit";
import { useApp, useLink } from "../ui/state";
import { c } from "../ui/theme";
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
        (e: Error) => setError(e.message),
      );
    } else if (isText) {
      client.files.read.query({ path: p.path, offset: 0, length: PREVIEW }).then(
        (r) => {
          const bin = atob(r.data);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          setText(new TextDecoder().decode(arr) + (r.eof ? "" : "\n\n… (first 512 kB)"));
        },
        (e: Error) => setError(e.message),
      );
    }
  }, [client, p.path, p.name, isImage, isText, bytes]);

  return (
    <Screen
      title={p.name}
      right={<Button label="Back" icon="chevron-back" onPress={() => router.back()} />}
      scroll={false}
    >
      <T size={12} color={c.subtle}>
        {p.path} · {size(bytes)}
      </T>
      {error ? <T color={c.red}>{error}</T> : null}
      {image ? (
        <Image source={{ uri: image }} style={{ flex: 1, borderRadius: 12 }} resizeMode="contain" />
      ) : null}
      {text !== null ? (
        <ScrollView
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", borderRadius: 12 }}
          contentContainerStyle={{ padding: 10 }}
        >
          <T mono style={s.mono}>
            {text}
          </T>
        </ScrollView>
      ) : null}
      {!isImage && !isText ? (
        <Card>
          <T color={c.dim}>No preview for this kind of file.</T>
        </Card>
      ) : null}
      <Button
        label="Download to the phone"
        icon="download"
        kind="primary"
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
    </Screen>
  );
}
