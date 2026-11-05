import { QueryCache } from '../../api/query-cache';
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
const queryCaches = new WeakMap<object, unknown>();
function parserCache<T>(parse: (raw: unknown) => T): QueryCache<T> {
  let cache = queryCaches.get(parse);
  if (!cache) {
    cache = new QueryCache<T>();
    queryCaches.set(parse, cache);
  }
  // A parser's identity owns exactly its return type.
  return cache as QueryCache<T>;
}
/** Sequential polling prevents overlap; navigation aborts and discards stale responses. */
function usePolling<T>(
  path: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  interval: number | null,
  cache: QueryCache<T>,
  maxAge: number,
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
        const data = await cache.read(
          path!,
          load,
          controller.signal,
          maxAge,
          revision > 0 || stopped,
        );
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
  }, [path, load, revision, cache, interval, maxAge]);
  const current = state.path === path ? state : undefined;
  const data = current?.data ?? (path ? cache.peek(path) : undefined);
  return {
    data,
    error: current?.error ?? '',
    loading: path !== null && data === undefined && !current?.error,
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
  const cache = useMemo(() => parserCache(parse), [parse]);
  return usePolling(
    path,
    load,
    interval,
    cache,
    cacheCompleted ? Infinity : (interval ?? 15000),
  );
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
  const cache = useMemo(() => parserCache(parse), [parse]);
  return usePolling(
    path ? `all:${path}` : null,
    load,
    interval,
    cache,
    interval ?? 15000,
  );
}
