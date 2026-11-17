/** Start Claude (or Codex) in one of your projects, with a first prompt: a sheet. */
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { errorText } from "../ui/errors";
import { Icon } from "../ui/icon";
import { Btn, Item, List, Sheet, Txt } from "../ui/lac";
import { useApp, useLink, usePoll } from "../ui/state";
import { font, k } from "../ui/theme";

const AGENTS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
] as const;

export default function NewSession() {
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const projects = usePoll(() => client?.agents.projects.query() ?? null, [client], 60_000);
  const [project, setProject] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!client || !project) return;
    setBusy(true);
    setError(null);
    const first = prompt.trim();
    await client.agents.start
      .mutate({ project, prompt: first ? first : null, agent })
      .then((s) => router.replace({ pathname: "/agent/[id]", params: { id: s.id } }))
      .catch((e: unknown) => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  return (
    <Sheet title="New session">
      {/* Which agent: a two-way switch. */}
      <View
        accessibilityRole="radiogroup"
        style={{
          flexDirection: "row",
          borderWidth: 1,
          borderColor: k.line,
          borderRadius: 14,
          padding: 3,
          marginBottom: 16,
          backgroundColor: k.ink,
        }}
      >
        {AGENTS.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => setAgent(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: agent === o.value }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 8,
              borderRadius: 11,
              backgroundColor: agent === o.value ? k.plum2 : "transparent",
            }}
          >
            <Txt w="600" size={14} color={agent === o.value ? k.text : k.sub}>
              {o.label}
            </Txt>
          </Pressable>
        ))}
      </View>

      <Txt size={13} color={k.sub} style={{ marginBottom: 8 }}>
        Project
      </Txt>
      {projects.error ? (
        <Txt size={13.5} color={k.rose} style={{ marginBottom: 8 }}>
          {projects.error}
        </Txt>
      ) : null}
      {projects.data ? (
        <List style={{ backgroundColor: k.ink }}>
          {projects.data.slice(0, 30).map((p) => (
            <Item
              key={p.path}
              glyph="folder"
              glyphColor={project === p.path ? k.brass2 : k.text}
              title={p.name}
              sub={p.path}
              right={
                project === p.path ? <Icon name="check" size={20} color={k.brass2} /> : undefined
              }
              onPress={() => setProject(p.path)}
              label={`${p.name}${project === p.path ? ", chosen" : ""}`}
            />
          ))}
        </List>
      ) : (
        <Txt size={13.5} color={k.mute}>
          Reading your projects…
        </Txt>
      )}

      <Txt size={13} color={k.sub} style={{ marginTop: 16, marginBottom: 8 }}>
        First prompt (optional)
      </Txt>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Fix the failing tests in src/api"
        placeholderTextColor={k.mute}
        accessibilityLabel="First prompt"
        style={{
          minHeight: 72,
          maxHeight: 160,
          backgroundColor: k.ink,
          borderWidth: 1,
          borderColor: k.line2,
          borderRadius: 14,
          paddingHorizontal: 14,
          paddingVertical: 12,
          color: k.text,
          fontFamily: font.body,
          fontSize: 15,
          textAlignVertical: "top",
        }}
      />
      {error ? (
        <Txt size={13.5} color={k.rose} style={{ marginTop: 10 }}>
          {error}
        </Txt>
      ) : null}
      <Btn
        label="Start"
        kind="solid"
        icon="play"
        busy={busy}
        disabled={!project || !client}
        onPress={start}
      />
    </Sheet>
  );
}
