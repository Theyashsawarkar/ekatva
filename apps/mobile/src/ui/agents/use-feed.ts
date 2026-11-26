/** An agent's history, followed live while its screen is in front, older pages on demand. */
import type { AgentUpdate } from "@ekatva/protocol";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { applyUpdate, type Feed, hasOlder, prepend } from "../../core/agent-feed";
import type { Session } from "../../core/session";
import { errorText } from "../errors";

type Client = NonNullable<Session["link"]["client"]>;

export function useFeed(client: Client | null, id: string, on: boolean) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const now = useRef<Feed | null>(null);
  const busy = useRef(false);
  const put = useCallback((f: Feed | null) => {
    now.current = f;
    setFeed(f);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!client || !on) return;
      let sub: { unsubscribe(): void } | null = null;
      let retry: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        sub?.unsubscribe();
        sub = null;
        if (retry) clearTimeout(retry);
        retry = null;
      };
      const start = () => {
        stop();
        sub = client.agents.follow.subscribe(
          { id },
          {
            onData: (u: AgentUpdate) => {
              setError(null);
              put(applyUpdate(now.current, u));
            },
            onError: (e) => {
              setError(errorText(e));
              stop();
              retry = setTimeout(start, 3000);
            },
          },
        );
      };
      if (AppState.currentState === "active") start();
      const app = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
      return () => {
        app.remove();
        stop();
      };
    }, [client, id, on, put]),
  );

  const older = useCallback(async () => {
    const f = now.current;
    if (!client || !f || !hasOlder(f) || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await client.agents.history.query({ id, before: f.items[0]?.n ?? 0, limit: 80 });
      if (now.current) put(prepend(now.current, page));
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [client, id, put]);

  const output = useCallback(
    (n: number) =>
      client && now.current
        ? client.agents.output.query({ id, n, epoch: now.current.epoch })
        : Promise.reject(new Error("the laptop isn't connected")),
    [client, id],
  );
  return { feed, error, loading, older, output };
}
