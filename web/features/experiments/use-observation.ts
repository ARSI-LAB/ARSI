import { subscribeRetry } from '../../api/connection-state';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { readObservation, type Page } from '../../api/observation-client';
import { readAllObservationPages } from '../../api/read-all-pages';

export interface QueryState<T> {
  data: T | undefined;
  error: string;
  loading: boolean;
  refresh: () => void;
}
const completedQueries = new WeakMap<object, Map<string, unknown>>();
/** Sequential polling prevents overlap; navigation aborts and discards stale responses. */
function usePolling<T>(
  path: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  interval: number | null,
  cache?: { read(): T | undefined; write(data: T): void },
): QueryState<T> {
  const previousInterval = useRef(interval);
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string;
  }>({ path, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeRetry(() => setRevision((value) => value + 1)), []);
  useEffect(() => {
    const stopped = previousInterval.current !== null && interval === null;
    previousInterval.current = interval;
    if (path === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update(): Promise<void> {
      try {
        const data =
          (revision === 0 && !stopped ? cache?.read() : undefined) ??
          (await load(controller.signal));
        if (!controller.signal.aborted) cache?.write(data);
        if (!controller.signal.aborted) setState({ path, data, error: '' });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            path,
            data: previous.path === path ? previous.data : undefined,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        if (!controller.signal.aborted && interval !== null)
          timer = setTimeout(() => {
            if (interval !== null) void update();
          }, interval);
      }
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, load, revision, cache, interval]);
  const current = state.path === path ? state : undefined;
  return {
    data: current?.data,
    error: current?.error ?? '',
    loading: path !== null && !current?.data && !current?.error,
    refresh: () => setRevision((value) => value + 1),
  };
}
export function useObservation<T>(
  path: string | null,
  parse: (raw: unknown) => T,
  interval: number | null = 4000,
  cacheCompleted = false,
): QueryState<T> {
  const load = useCallback(
    (signal: AbortSignal) => readObservation(path ?? '', parse, signal),
    [path, parse],
  );
  const cache = useMemo(() => {
    if (!cacheCompleted || !path) return undefined;
    let entries = completedQueries.get(parse);
    if (!entries) {
      entries = new Map();
      completedQueries.set(parse, entries);
    }
    const store = entries;
    return {
      read: () => (store.has(path) ? parse(store.get(path)) : undefined),
      write: (data: T) => {
        store.delete(path);
        store.set(path, data);
        if (store.size > 40) store.delete(store.keys().next().value!);
      },
    };
  }, [cacheCompleted, path, parse]);
  return usePolling(path, load, interval, cache);
}
export function useAllObservations<T>(
  path: string | null,
  parse: (raw: unknown) => Page<T>,
  interval: number | null = 15000,
): QueryState<Page<T>> {
  const load = useCallback(
    (signal: AbortSignal) => readAllObservationPages(path ?? '', parse, signal),
    [path, parse],
  );
  return usePolling(path, load, interval);
}
