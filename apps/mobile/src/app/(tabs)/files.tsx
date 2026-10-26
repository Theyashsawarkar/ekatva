import type { FileEntry } from "@ekatva/protocol";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Button, Card, Empty, Field, Row, Screen, T } from "../../ui/kit";
import { useApp, useLink, usePoll } from "../../ui/state";
import { c } from "../../ui/theme";
import { downloadToPhone, size } from "../../ui/transfer";

const CHUNK = 3 * 1024 * 1024;

export default function Files() {
  const { session, confirm } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const [path, setPath] = useState("~");
  const listing = usePoll(() => client?.files.list.query({ path }) ?? null, [client, path], 15_000);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parts = path === "~" ? ["~"] : ["~", ...path.slice(2).split("/")];
  const crumbs = parts.map((part, i) => ({
    part,
    path: i === 0 ? "~" : `~/${parts.slice(1, i + 1).join("/")}`,
  }));

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await f();
      listing.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets[0] || !client) return;
    const a = r.assets[0];
    await run(`Sending ${a.name}`, async () => {
      const bytes = await new File(a.uri).bytes();
      const target = `${path}/${a.name}`;
      for (let off = 0; off < bytes.length || off === 0; off += CHUNK) {
        const piece = bytes.subarray(off, off + CHUNK);
        let bin = "";
        for (const b of piece) bin += String.fromCharCode(b);
        await client.files.write.mutate({
          path: target,
          data: btoa(bin),
          mode: off === 0 ? "create" : "append",
        });
        if (!bytes.length) break;
      }
    });
  };

  const actions = (e: FileEntry) =>
    Alert.alert(e.name, `${e.kind === "dir" ? "Folder" : size(e.size)} · ${e.path}`, [
      {
        text: "Rename",
        onPress: () => {
          setRenaming(e);
          setName(e.name);
        },
      },
      ...(e.kind === "file"
        ? [
            {
              text: "Download",
              onPress: () => void run(`Downloading ${e.name}`, () => downloadToPhone(client!, e)),
            },
          ]
        : []),
      {
        text: "Delete",
        style: "destructive" as const,
        onPress: () =>
          void confirm(`Delete ${e.name} on the laptop?`).then(async (ok) => {
            if (ok)
              await run(`Deleting ${e.name}`, () => client!.files.remove.mutate({ path: e.path }));
          }),
      },
      { text: "Cancel", style: "cancel" as const },
    ]);

  if (!client) {
    return (
      <Screen title="Files">
        <Empty
          icon="cloud-offline"
          title="Not connected"
          detail="Your laptop's files show up here when the phone reaches it."
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Files"
      right={
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Button label="" icon="folder-open" onPress={() => setFolder("")} />
          <Button label="" icon="cloud-upload" kind="primary" onPress={() => void upload()} />
        </View>
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 4, alignItems: "center" }}
      >
        {crumbs.map((crumb, i) => (
          <Button
            key={crumb.path}
            label={crumb.part}
            kind={i === crumbs.length - 1 ? "primary" : "plain"}
            style={{ paddingVertical: 6, paddingHorizontal: 10 }}
            onPress={() => setPath(crumb.path)}
          />
        ))}
      </ScrollView>
      {busy ? <T color={c.accent}>{busy}…</T> : null}
      {error ? (
        <Card tone="red">
          <T color={c.red}>{error}</T>
        </Card>
      ) : null}
      {folder !== null ? (
        <Card>
          <Field label="New folder" value={folder} onChangeText={setFolder} autoFocus />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label="Make it"
              kind="primary"
              disabled={!folder.trim()}
              onPress={() =>
                void run("Making the folder", () =>
                  client.files.mkdir.mutate({ path: `${path}/${folder.trim()}` }),
                ).then(() => setFolder(null))
              }
            />
            <Button label="Cancel" onPress={() => setFolder(null)} />
          </View>
        </Card>
      ) : null}
      {renaming ? (
        <Card>
          <Field label={`Rename ${renaming.name}`} value={name} onChangeText={setName} autoFocus />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label="Rename"
              kind="primary"
              disabled={!name.trim() || name === renaming.name}
              onPress={() =>
                void run("Renaming", () =>
                  client.files.move.mutate({
                    from: renaming.path,
                    to: `${path}/${name.trim()}`,
                    overwrite: false,
                  }),
                ).then(() => setRenaming(null))
              }
            />
            <Button label="Cancel" onPress={() => setRenaming(null)} />
          </View>
        </Card>
      ) : null}
      {listing.error ? (
        <Card tone="red">
          <T color={c.red}>{listing.error}</T>
        </Card>
      ) : null}
      <Card style={{ padding: 4, gap: 0 }}>
        {(listing.data ?? [])
          .filter((e) => !e.name.startsWith("."))
          .map((e) => (
            <Row
              key={e.path}
              icon={
                e.kind === "dir"
                  ? "folder"
                  : e.mime?.startsWith("image/")
                    ? "image-outline"
                    : e.mime?.startsWith("video/")
                      ? "film-outline"
                      : "document-text-outline"
              }
              title={e.name}
              detail={
                e.kind === "dir"
                  ? undefined
                  : `${size(e.size)} · ${new Date(e.mtime).toLocaleDateString()}`
              }
              onPress={() =>
                e.kind === "dir"
                  ? setPath(e.path)
                  : router.push({
                      pathname: "/file",
                      params: {
                        path: e.path,
                        name: e.name,
                        size: String(e.size),
                        mime: e.mime ?? "",
                      },
                    })
              }
              onLongPress={() => actions(e)}
            />
          ))}
        {listing.data && !listing.data.length ? (
          <T color={c.subtle} style={{ padding: 12 }}>
            Empty folder.
          </T>
        ) : null}
      </Card>
      <T size={12} color={c.subtle}>
        Long-press for rename, download and delete. Every change can be undone from the Log.
      </T>
    </Screen>
  );
}
