import type { FileEntry } from "@ekatva/protocol";
import { router } from "expo-router";
import { memo, useEffect, useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, TextInput, View } from "react-native";
import { errorText } from "../../ui/errors";
import { Seg } from "../../ui/files/seg";
import { Icon, type IconName } from "../../ui/icon";
import { Btn, Field, H2, Item, Page, Panel, Txt, toast } from "../../ui/lac";
import { pickDocuments } from "../../ui/pick";
import { useApp, useLaptop, useLink, usePoll } from "../../ui/state";
import { font, k } from "../../ui/theme";
import { downloadToPhone, eachPiece, size } from "../../ui/transfer";

/** A file's short type, as its recent card shows it (".ts"). */
const extOf = (e: FileEntry) =>
  e.name.includes(".") ? `.${(e.name.split(".").pop() ?? "").toLowerCase().slice(0, 4)}` : "";

const glyphOf = (e: FileEntry): IconName =>
  e.kind === "dir" ? "folder" : e.mime?.startsWith("image/") ? "image" : "doc";

/** Places worth showing first, when they exist. */
const PLACES = [
  "Downloads",
  "codes",
  "personal",
  "Documents",
  "Pictures",
  "Desktop",
  "Music",
  "Videos",
];

const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`);
const day = (ms: number) => {
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString()
    ? "today"
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

type Side = "laptop" | "phone";

export default function Files() {
  const { session, confirm } = useApp();
  const link = useLink();
  const laptop = useLaptop();
  const name0 = laptop?.name ?? "Laptop";
  const client = link.status === "online" ? session?.link.client : null;
  const [side, setSide] = useState<Side>("laptop");
  const [path, setPath] = useState("~");
  const listing = usePoll(
    () =>
      side === "phone"
        ? (session?.files.list(path, { allowPrivate: false }) ?? null)
        : (client?.files.list.query({ path }) ?? null),
    [client, session, side, path],
    // The phone's own folders reload when you come back here, not on a timer.
    side === "phone" ? 10 * 60_000 : 15_000,
  );
  const home = path === "~";
  const laptopHome = home && side === "laptop";
  const overview = usePoll(
    () => (laptopHome ? (client?.files.overview.query() ?? null) : null),
    [client, laptopHome],
    60_000,
  );
  const places = laptopHome
    ? PLACES.filter((pl) => (listing.data ?? []).some((e) => e.kind === "dir" && e.name === pl))
    : [];
  const [counts, setCounts] = useState<Record<string, number>>({});
  const placeKey = places.join(",");
  useEffect(() => {
    if (!client || !placeKey) return;
    for (const name of placeKey.split(","))
      void client.files.list
        .query({ path: `~/${name}` })
        .then((l) =>
          setCounts((c0) => ({ ...c0, [name]: l.filter((e) => !e.name.startsWith(".")).length })),
        )
        .catch(() => undefined);
  }, [client, placeKey]);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const parts = path === "~" ? ["~"] : ["~", ...path.slice(2).split("/")];
  const crumbs = parts.map((part, i) => ({
    part: i === 0 ? "Home" : part,
    path: i === 0 ? "~" : `~/${parts.slice(1, i + 1).join("/")}`,
  }));
  const switchSide = (s0: Side) => {
    setSide(s0);
    setPath("~");
    setSearch(null);
  };
  const go = (p0: string) => {
    setPath(p0);
    setSearch(null);
  };

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    await f()
      .then(() => listing.reload())
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  const upload = async () => {
    const r = await pickDocuments(false);
    if (r.canceled || !r.assets[0] || !client) return;
    const a = r.assets[0];
    await run(`Sending ${a.name}`, async () => {
      const target = `${path}/${a.name}`;
      // Piece by piece from the file (512 KiB), never the whole file in memory.
      await eachPiece(a.uri, async (data, offset) => {
        await client.files.write.mutate({
          path: target,
          data,
          mode: offset === 0 ? "create" : "append",
        });
      });
    });
  };

  const open = (e: FileEntry) => {
    if (e.kind === "dir") return go(e.path);
    if (side === "phone") return toast("It's on this phone");
    router.push({
      pathname: "/file",
      params: { path: e.path, name: e.name, size: String(e.size), mime: e.mime ?? "" },
    });
  };

  const actions = (e: FileEntry) =>
    Alert.alert(e.name, `${e.kind === "dir" ? "Folder" : size(e.size)}, ${e.path}`, [
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

  const plus = () =>
    Alert.alert(`Add to ${path === "~" ? name0 : path}`, undefined, [
      { text: "Upload a file", onPress: () => void upload() },
      { text: "New folder", onPress: () => setFolder("") },
      { text: "Cancel", style: "cancel" },
    ]);

  const all = (listing.data ?? []).filter((e) => !e.name.startsWith("."));
  const q = search?.trim().toLowerCase() ?? "";
  const rows = (
    laptopHome
      ? [
          ...places.flatMap((pl) => all.filter((e) => e.name === pl)),
          ...all.filter((e) => !places.includes(e.name)),
        ]
      : all
  ).filter((e) => !q || e.name.toLowerCase().includes(q));
  const disk = overview.data?.disk;
  const recent = overview.data?.recent ?? [];
  const offline = side === "laptop" && !client;

  return (
    <Page
      title="Files"
      scroll={false}
      bottom={0}
      right={
        <View style={{ flexDirection: "row", gap: 16 }}>
          <Pressable
            onPress={() => setSearch(search === null ? "" : null)}
            accessibilityRole="button"
            accessibilityLabel={search === null ? "Search this folder" : "Stop searching"}
            hitSlop={10}
          >
            <Icon name={search === null ? "search" : "close"} color={k.brass2} />
          </Pressable>
          {side === "laptop" && client ? (
            <Pressable
              onPress={plus}
              accessibilityRole="button"
              accessibilityLabel="Upload a file or make a folder here"
              hitSlop={10}
            >
              <Icon name="plus" color={k.brass2} />
            </Pressable>
          ) : null}
        </View>
      }
    >
      <FlatList
        data={offline ? [] : rows}
        keyExtractor={(e) => e.path}
        ListHeaderComponent={
          <>
            <Seg
              value={side}
              onChange={switchSide}
              options={[
                { value: "laptop", label: name0 },
                { value: "phone", label: "This phone" },
              ]}
            />

            {search !== null ? (
              <View style={st.search}>
                <Icon name="search" size={17} color={k.mute} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  autoFocus
                  placeholder={`Search ${home ? "here" : (parts[parts.length - 1] ?? "")}`}
                  placeholderTextColor={k.mute}
                  style={st.searchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ) : null}

            {offline ? (
              <View style={{ alignItems: "center", paddingVertical: 48, gap: 8 }}>
                <Icon name="offline" size={36} color={k.mute} />
                <Txt display w="600" size={19}>
                  Not connected
                </Txt>
                <Txt size={14} color={k.sub} align="center">
                  {name0}'s files show up here when the phone reaches it.
                </Txt>
              </View>
            ) : null}

            {!offline && !home ? (
              <View style={st.crumbs}>
                {crumbs.map((cr, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <View key={cr.path} style={{ flexDirection: "row", gap: 6 }}>
                      {i ? (
                        <Txt size={14} color={k.sub}>
                          /
                        </Txt>
                      ) : null}
                      <Pressable
                        onPress={() => go(cr.path)}
                        disabled={last}
                        hitSlop={6}
                        accessibilityRole="link"
                      >
                        <Txt size={14} w={last ? "600" : "400"} color={last ? k.text : k.sub}>
                          {cr.part}
                        </Txt>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {laptopHome && client && search === null ? (
              <>
                {disk ? (
                  <Panel style={{ padding: 16 }}>
                    <View
                      style={{ flexDirection: "row", alignItems: "baseline" }}
                      accessibilityLabel={`${gb(disk.free)} free of ${gb(disk.total)}`}
                    >
                      <Txt display w="700" size={30} style={{ letterSpacing: -0.6 }}>
                        {gb(disk.free)}
                      </Txt>
                      <Txt w="500" size={15} color={k.sub} style={{ marginLeft: 6 }}>
                        free of {gb(disk.total)}
                      </Txt>
                    </View>
                    <View style={st.bar}>
                      <View
                        style={{
                          width: `${Math.round((1 - disk.free / disk.total) * 100)}%`,
                          height: "100%",
                          backgroundColor: k.steel,
                          borderRadius: 99,
                        }}
                      />
                    </View>
                    <View style={{ flexDirection: "row", gap: 14, marginTop: 10 }}>
                      <Legend color={k.steel} label={`Used ${gb(disk.total - disk.free)}`} />
                      <Legend color={k.ink} label="Free" />
                    </View>
                  </Panel>
                ) : null}
                {recent.length ? (
                  <>
                    <H2>Recent</H2>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={{ marginHorizontal: -20 }}
                      contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}
                    >
                      {recent.map((e) => (
                        <Pressable
                          key={e.path}
                          onPress={() => open(e)}
                          onLongPress={() => actions(e)}
                          accessibilityRole="button"
                          accessibilityLabel={`${e.name}, ${size(e.size)}`}
                          style={{ width: 112 }}
                        >
                          <View style={st.preview}>
                            {e.mime?.startsWith("image/") || !extOf(e) ? (
                              <Icon name={glyphOf(e)} size={28} color={k.sub} />
                            ) : (
                              <Txt display w="600" size={18} color={k.sub}>
                                {extOf(e)}
                              </Txt>
                            )}
                          </View>
                          <Txt w="500" size={13.5} lines={1}>
                            {e.name}
                          </Txt>
                          <Txt size={12} color={k.mute} lines={1}>
                            {size(e.size)}
                          </Txt>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </>
                ) : null}
                <H2>Places</H2>
              </>
            ) : null}

            {busy ? (
              <Txt size={14} color={k.brass2} style={{ marginBottom: 10 }}>
                {busy}…
              </Txt>
            ) : null}
            {error || listing.error ? (
              <Panel style={{ padding: 14, marginBottom: 12, borderColor: `${k.rose}73` }}>
                <Txt size={14} color={k.rose}>
                  {error ?? listing.error}
                </Txt>
              </Panel>
            ) : null}
            {folder !== null && client ? (
              <Panel style={{ padding: 16, marginBottom: 12 }}>
                <Field label="New folder" value={folder} onChangeText={setFolder} autoFocus />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Btn
                    label="Make it"
                    kind="solid"
                    style={{ flex: 1 }}
                    disabled={!folder.trim()}
                    onPress={() =>
                      void run("Making the folder", () =>
                        client.files.mkdir.mutate({ path: `${path}/${folder.trim()}` }),
                      ).then(() => setFolder(null))
                    }
                  />
                  <Btn label="Cancel" style={{ flex: 1 }} onPress={() => setFolder(null)} />
                </View>
              </Panel>
            ) : null}
            {renaming && client ? (
              <Panel style={{ padding: 16, marginBottom: 12 }}>
                <Field
                  label={`Rename ${renaming.name}`}
                  value={name}
                  onChangeText={setName}
                  autoFocus
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Btn
                    label="Rename"
                    kind="solid"
                    style={{ flex: 1 }}
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
                  <Btn label="Cancel" style={{ flex: 1 }} onPress={() => setRenaming(null)} />
                </View>
              </Panel>
            ) : null}
          </>
        }
        renderItem={({ item, index }) => (
          <FileRow
            e={item}
            first={index === 0}
            last={index === rows.length - 1}
            sub={
              item.kind === "dir"
                ? counts[item.name] != null && laptopHome
                  ? `${counts[item.name]} items`
                  : "Folder"
                : `${size(item.size)}, ${day(item.mtime)}`
            }
            onOpen={open}
            onMore={side === "laptop" ? actions : undefined}
          />
        )}
        getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
        ListEmptyComponent={
          offline ? undefined : (
            <Panel style={{ padding: 16 }}>
              <Txt size={14} color={k.sub}>
                {!listing.data ? "Loading…" : q ? "Nothing by that name here" : "Empty folder"}
              </Txt>
            </Panel>
          )
        }
        contentContainerStyle={{ paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={14}
        windowSize={7}
        removeClippedSubviews
      />
    </Page>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          backgroundColor: color,
          borderWidth: 1,
          borderColor: k.line2,
        }}
      />
      <Txt size={12.5} color={k.sub}>
        {label}
      </Txt>
    </View>
  );
}

const st = {
  search: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    backgroundColor: k.ink2,
    borderWidth: 1,
    borderColor: k.line2,
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 46,
    marginBottom: 16,
  },
  searchInput: { flex: 1, color: k.text, fontFamily: font.body, fontSize: 15, padding: 0 },
  crumbs: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 6,
    alignItems: "center" as const,
    marginBottom: 12,
  },
  bar: {
    height: 8,
    borderRadius: 99,
    backgroundColor: k.ink,
    marginTop: 12,
    overflow: "hidden" as const,
  },
  preview: {
    height: 136,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: k.line,
    backgroundColor: k.ink2,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginBottom: 8,
  },
};

/** A row's height, fixed so the list can place rows without measuring them. */
const ROW = 64;

/** One file or folder: drawn again only when its own entry changes. */
const FileRow = memo(function FileRow({
  e,
  first,
  last,
  sub,
  onOpen,
  onMore,
}: {
  e: FileEntry;
  first: boolean;
  last: boolean;
  sub: string;
  onOpen: (e: FileEntry) => void;
  onMore?: (e: FileEntry) => void;
}) {
  return (
    <View
      style={{
        height: ROW,
        backgroundColor: k.ink2,
        borderColor: k.line,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderTopWidth: first ? 1 : 0,
        borderBottomWidth: last ? 1 : 0,
        borderTopLeftRadius: first ? 20 : 0,
        borderTopRightRadius: first ? 20 : 0,
        borderBottomLeftRadius: last ? 20 : 0,
        borderBottomRightRadius: last ? 20 : 0,
        overflow: "hidden",
      }}
    >
      {first ? null : <View style={{ height: 1, marginLeft: 62, backgroundColor: k.line }} />}
      <Item
        glyph={glyphOf(e)}
        title={e.name}
        sub={sub}
        onPress={() => onOpen(e)}
        onLongPress={onMore ? () => onMore(e) : undefined}
        style={{ flex: 1 }}
        right={
          onMore ? (
            <Pressable
              onPress={() => onMore(e)}
              accessibilityRole="button"
              accessibilityLabel={`Rename, download or delete ${e.name}`}
              hitSlop={12}
            >
              <Icon name="more" color={k.mute} />
            </Pressable>
          ) : null
        }
      />
    </View>
  );
});
