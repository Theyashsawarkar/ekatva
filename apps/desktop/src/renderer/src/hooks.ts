import { useEffect, useState } from "react";

/** Loads now and every `ms`; `reload()` loads again at once. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], ms = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (d) => {
          if (live) {
            setData(d);
            setError(null);
          }
        },
        (e: Error) => live && setError(e.message),
      );
    void run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

/** Follows a subscription; the latest value. */
export function useSub<T>(
  subscribe: (onData: (v: T) => void) => { unsubscribe(): void },
  deps: unknown[],
): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    const s = subscribe(setV);
    return () => s.unsubscribe();
  }, deps);
  return v;
}
