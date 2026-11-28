import { useEffect, useState, useRef } from 'react';
import { subscribeRetry } from '../api/connection-state';
import type { QueryCache } from '../api/query-cache';

export interface QueryState<T> {
  data: T | undefined;
  error: string;
  loading: boolean;
  refresh: () => void;
}
/** Sequential polling prevents overlap; navigation aborts and discards stale responses. */
export function usePolling<T>(
  path: string | null,
  load: (signal: AbortSignal, force: boolean) => Promise<T>,
  interval: number | null,
  cache: QueryCache<T> | null,
  maxAge: number,
  refreshDisplay: 'retain' | 'reset' = 'retain',
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
    if (refreshDisplay === 'reset')
      setState({ path, data: cache?.peek(path), error: '' });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update(): Promise<void> {
      try {
        const force = revision > 0 || stopped;
        const data = cache
          ? await cache.read(
              path!,
              (signal) => load(signal, force),
              controller.signal,
              maxAge,
              force,
            )
          : await load(controller.signal, force);
        if (!controller.signal.aborted) setState({ path, data, error: '' });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            path,
            data:
              refreshDisplay === 'retain' && previous.path === path
                ? previous.data
                : undefined,
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
  }, [path, load, revision, cache, interval, maxAge, refreshDisplay]);
  const current = state.path === path ? state : undefined;
  const data =
    current?.error && refreshDisplay === 'reset'
      ? undefined
      : (current?.data ?? (path ? cache?.peek(path) : undefined));
  return {
    data,
    error: current?.error ?? '',
    loading: path !== null && data === undefined && !current?.error,
    refresh: () => setRevision((value) => value + 1),
  };
}
