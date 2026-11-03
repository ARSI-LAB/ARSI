import { parseRoute, route } from './routing.js';
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const key = (id: string, view: string): string =>
  `rsi.web.view:${JSON.stringify([id, view])}`;

/** Remember browser-only selectors per experiment/view; never cache experiment data. */
export function rememberView(hash: string, storage?: ViewStorage): void {
  const state = parseRoute(hash);
  if (!state.id) return;
  try {
    (storage ?? window.sessionStorage).setItem(
      key(state.id, state.view),
      route(state.id, state.view, state.candidate, state.artifact, state),
    );
  } catch {
    // Storage may be disabled or full; URL and browser-back navigation remain available.
  }
}
export function viewRoute(
  id: string,
  view: string,
  storage?: ViewStorage,
): string {
  try {
    const hash = (storage ?? window.sessionStorage).getItem(key(id, view));
    if (hash?.startsWith('#')) {
      const state = parseRoute(hash);
      if (state.id === id && state.view === view)
        return route(id, view, state.candidate, state.artifact, state);
    }
  } catch {
    // Optional local navigation state must not block access to recorded facts.
  }
  return route(id, view);
}
