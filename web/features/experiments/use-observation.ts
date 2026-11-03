import { useCallback, useEffect, useState } from 'react';
import { readObservation, type Page } from '../../api/observation-client';
import { readAllObservationPages } from '../../api/read-all-pages';

interface QueryState<T> {
  data: T | undefined;
  error: string;
  loading: boolean;
  refresh: () => void;
}
/** Sequential polling prevents overlap; navigation aborts and discards stale responses. */
function usePolling<T>(
  path: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  interval: number | null,
): QueryState<T> {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string;
  }>({ path, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update(): Promise<void> {
      try {
        const data = await load(controller.signal);
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
          timer = setTimeout(() => void update(), interval);
      }
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, load, revision, interval]);
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
): QueryState<T> {
  const load = useCallback(
    (signal: AbortSignal) => readObservation(path ?? '', parse, signal),
    [path, parse],
  );
  return usePolling(path, load, interval);
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
