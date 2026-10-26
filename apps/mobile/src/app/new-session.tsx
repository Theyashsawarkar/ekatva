import { router } from "expo-router";
import { useState } from "react";
import { Button, Card, Field, Row, Screen, T } from "../ui/kit";
import { useApp, useLink, usePoll } from "../ui/state";
import { c } from "../ui/theme";

/** Start Claude (or Codex) in one of your projects, with a first prompt. */
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
    try {
      const s = await client.agents.start.mutate({ project, prompt: prompt.trim() || null, agent });
      router.replace({ pathname: "/agent/[id]", params: { id: s.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Screen title="New session" right={<Button label="Close" onPress={() => router.back()} />}>
      <Card>
        <T weight="700">Agent</T>
        <Row
          title="Claude Code"
          icon={agent === "claude" ? "radio-button-on" : "radio-button-off"}
          onPress={() => setAgent("claude")}
        />
        <Row
          title="Codex"
          icon={agent === "codex" ? "radio-button-on" : "radio-button-off"}
          onPress={() => setAgent("codex")}
        />
      </Card>
      <Card>
        <T weight="700">Project</T>
        {projects.error ? <T color={c.red}>{projects.error}</T> : null}
        {(projects.data ?? []).slice(0, 30).map((p) => (
          <Row
            key={p.path}
            title={p.name}
            detail={p.path}
            icon={project === p.path ? "radio-button-on" : "folder-outline"}
            onPress={() => setProject(p.path)}
          />
        ))}
      </Card>
      <Field
        label="First prompt (optional)"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Fix the failing tests in src/api"
      />
      {error ? <T color={c.red}>{error}</T> : null}
      <Button
        label="Start"
        kind="primary"
        icon="play"
        busy={busy}
        disabled={!project}
        onPress={start}
      />
    </Screen>
  );
}
