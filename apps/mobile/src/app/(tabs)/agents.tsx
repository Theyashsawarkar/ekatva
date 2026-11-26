/**
 * Agents, by what they need from you: root first, then Asks you (answer
 * right here), Working, Finished (new until you've looked), Idle. Every row
 * opens its session.
 */

import type { AgentSession } from "@ekatva/protocol";
import { router } from "expo-router";
import { View } from "react-native";
import { stateOf } from "../../ui/agent-blocks";
import { Asks, Avatar, ago, base, left, nameOf, Spin, useNow } from "../../ui/agents/parts";
import { agentRoute } from "../../ui/agents/route";
import { errorText } from "../../ui/errors";
import { Icon } from "../../ui/icon";
import { Btn, H2, Item, List, Page, Pill, Txt, toast } from "../../ui/lac";
import { useUnseen } from "../../ui/seen";
import { useApp, useLink, usePoll } from "../../ui/state";
import { k } from "../../ui/theme";

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 16)}…` : s);

export default function Agents() {
  const { session } = useApp();
  const link = useLink();
  const client = link.status === "online" ? session?.link.client : null;
  const { data, error } = usePoll(() => client?.agents.list.query() ?? null, [client], 2000, {
    key: "agents.list",
  });
  // Root requests: only when this phone may answer them (else quietly nothing).
  const roots = usePoll(
    () => client?.root.pending.query().catch(() => []) ?? null,
    [client],
    2000,
    { key: "root.pending" },
  );
  const now = useNow();
  const list = data ?? [];
  const unseen = useUnseen(session?.platform.kv ?? null);
  const asks = list.filter((a) => a.question);
  const working = list.filter((a) => !a.question && a.state === "working");
  const done = list
    .filter((a) => !a.question && a.state === "done")
    .sort((x, y) => Number(unseen(y)) - Number(unseen(x)) || y.since - x.since);
  const idle = list.filter((a) => !a.question && a.state === "idle");
  const open = (a: AgentSession) => router.push(agentRoute(a.id));

  const answer = (a: AgentSession, key: string, label: string) => {
    if (!client || !a.question) return;
    client.agents.answer.mutate({ id: a.id, option: key, questionHash: a.question.hash }).then(
      () => toast(`Answered: ${short(label)}`),
      (e: unknown) => toast(errorText(e)),
    );
  };

  const row = (a: AgentSession) => {
    const st = stateOf(a);
    const wait = a.queued ? `, ${a.queued} queued` : "";
    const sub = a.question
      ? `In ${base(a.project)}, asked ${ago(a.since)} ago`
      : a.state === "working"
        ? `${a.activity || "Working"}${wait}`
        : a.state === "done"
          ? a.activity || `Finished ${ago(a.since)} ago`
          : `In ${base(a.project)}, idle ${ago(a.since)}`;
    const fresh = unseen(a);
    return (
      <Item
        key={a.id}
        glyph={<Avatar a={a} />}
        title={nameOf(a)}
        sub={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 }}>
            {a.state === "working" && !a.question ? <Spin /> : null}
            <Txt size={13} color={k.sub} lines={1} style={{ flex: 1 }}>
              {sub}
            </Txt>
          </View>
        }
        right={
          fresh ? (
            <View
              accessibilityLabel="new"
              style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: k.brass }}
            />
          ) : undefined
        }
        chev
        label={`${nameOf(a)}, ${st.says}${fresh ? ", new" : ""}, in ${base(a.project)}`}
        onPress={() => open(a)}
        style={{ paddingVertical: 14 }}
      />
    );
  };

  return (
    <Page title="Agents">
      {!client ? (
        <Quiet
          icon="offline"
          title="Not connected"
          detail="Agents show up when the phone reaches the laptop."
        />
      ) : null}
      {error ? (
        <Txt size={13.5} color={k.rose} style={{ marginBottom: 10 }}>
          {error}
        </Txt>
      ) : null}

      {(roots.data ?? []).map((r) => (
        <Asks
          key={r.id}
          tone="rose"
          title={`${r.requester} wants root`}
          sub={`${r.commands.length} command${r.commands.length === 1 ? "" : "s"}, ${left(r.at, now)} left`}
          action="Review"
          onPress={() => router.push({ pathname: "/root/[id]", params: { id: r.id } })}
          style={{ marginBottom: 10 }}
        />
      ))}

      {asks.length ? (
        <>
          <H2 style={{ marginTop: 6 }}>Asks you</H2>
          <List inset={66}>
            {asks.map((a) => (
              <View key={a.id}>
                {row(a)}
                <View
                  style={{ paddingTop: 4, paddingRight: 16, paddingBottom: 16, paddingLeft: 66 }}
                >
                  <Txt size={14.5} style={{ lineHeight: 21, marginBottom: 10 }}>
                    {a.question?.text}
                  </Txt>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {(a.question?.options ?? []).slice(0, 3).map((o, i) => (
                      <Pill
                        key={o.key}
                        label={short(o.label)}
                        tone={i ? "ghost" : "amber"}
                        onPress={() => answer(a, o.key, o.label)}
                      />
                    ))}
                  </View>
                </View>
              </View>
            ))}
          </List>
        </>
      ) : null}
      {working.length ? (
        <>
          <H2>Working</H2>
          <List inset={66}>{working.map(row)}</List>
        </>
      ) : null}
      {done.length ? (
        <>
          <H2>Finished</H2>
          <List inset={66}>{done.map(row)}</List>
        </>
      ) : null}
      {idle.length ? (
        <>
          <H2>Idle</H2>
          <List inset={66}>{idle.map(row)}</List>
        </>
      ) : null}

      {client && data && !list.length ? (
        <Quiet
          icon="agents"
          title="No agent sessions"
          detail="Claude Code, Codex, Aider or Gemini running in tmux show up here."
        />
      ) : null}
      {client ? (
        <Btn
          label="New session"
          onPress={() => router.push("/new-session")}
          style={{ marginTop: 22 }}
        />
      ) : null}
    </Page>
  );
}

function Quiet({
  icon,
  title,
  detail,
}: {
  icon: "offline" | "agents";
  title: string;
  detail: string;
}) {
  return (
    <View style={{ alignItems: "center", gap: 10, paddingVertical: 48, paddingHorizontal: 24 }}>
      <Icon name={icon} size={36} color={k.mute} />
      <Txt display w="600" size={19}>
        {title}
      </Txt>
      <Txt size={14} color={k.sub} align="center" style={{ lineHeight: 20 }}>
        {detail}
      </Txt>
    </View>
  );
}
