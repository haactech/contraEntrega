import { useCallback, useEffect, useRef, useState } from "react";
import { pollInterval } from "@/lib/polling";

export interface PolledResource<T> {
  data: T | null;
  error: unknown;
  /** True only until the first successful load. */
  loading: boolean;
  /** Fetch now (also resets the polling timer). */
  refresh: () => Promise<void>;
  /** Replace the data (e.g. with a mutation response) without fetching. */
  setData: (next: T) => void;
}

/**
 * Minimal polling hook. `load(previous, signal)` returns the new data, or `null`
 * when nothing changed (e.g. HTTP 304). `awaitingPayment(data)` picks the fast
 * interval. Polling pauses while the tab is hidden and resumes (with an
 * immediate refresh) when it becomes visible again.
 */
export function usePolling<T>(
  load: (previous: T | null, signal: AbortSignal) => Promise<T | null>,
  awaitingPayment: (data: T | null) => boolean | { awaitingPayment: boolean; busy: boolean },
  deps: ReadonlyArray<unknown>,
): PolledResource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const dataRef = useRef<T | null>(null);
  const loadRef = useRef(load);
  const awaitingRef = useRef(awaitingPayment);
  loadRef.current = load;
  awaitingRef.current = awaitingPayment;

  const timer = useRef<number | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);
  const gen = useRef(0);

  const commit = useCallback((next: T) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    const hint = awaitingRef.current(dataRef.current);
    const flags = typeof hint === "boolean" ? { awaitingPayment: hint, busy: false } : hint;
    const ms = pollInterval({ ...flags, hidden: document.visibilityState === "hidden" });
    if (ms === null || !alive.current) return;
    timer.current = window.setTimeout(() => void run(), ms);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, []);

  const run = useCallback(async () => {
    if (inflight.current || !alive.current) return;
    const g = gen.current;
    inflight.current = true;
    controller.current = new AbortController();
    try {
      const next = await loadRef.current(dataRef.current, controller.current.signal);
      if (g !== gen.current) return;
      if (next !== null) commit(next);
      setError(null);
    } catch (e) {
      if (g !== gen.current) return;
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(e);
    }
    if (g !== gen.current) return;
    inflight.current = false;
    setLoading(false);
    schedule();
  }, [commit, schedule]);

  useEffect(() => {
    alive.current = true;
    gen.current++;
    inflight.current = false;
    dataRef.current = null;
    setDataState(null);
    setError(null);
    setLoading(true);
    void run();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer.current);
        void run();
      } else {
        window.clearTimeout(timer.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
      controller.current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refresh = useCallback(async () => {
    window.clearTimeout(timer.current);
    await run();
  }, [run]);

  const setData = useCallback(
    (next: T) => {
      commit(next);
      schedule();
    },
    [commit, schedule],
  );

  return { data, error, loading, refresh, setData };
}
