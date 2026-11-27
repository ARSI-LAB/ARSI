import { QueryCache } from '../../api/query-cache';
import { usePolling, type QueryState } from '../../hooks/use-polling';
import { useCallback, useMemo } from 'react';
import { readObservation, type Page } from '../../api/observation-client';
import { readAllObservationPages } from '../../api/read-all-pages';

export type { QueryState } from '../../hooks/use-polling';
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
export function useObservation<T>(
  path: string | null,
  parse: (raw: unknown) => T,
  interval: number | null = 4000,
  cacheCompleted = false,
  options?: { cache: false },
): QueryState<T> {
  const load = useCallback(
    (signal: AbortSignal) => readObservation(path ?? '', parse, signal),
    [path, parse],
  );
  const cache = useMemo(() => parserCache(parse), [parse]);
  // A response fetched while running must never be promoted to permanent reuse.
  return usePolling(
    path === null ? null : cacheCompleted ? `completed:${path}` : path,
    load,
    interval,
    options?.cache === false ? null : cache,
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
