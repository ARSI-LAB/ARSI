import { useSyncExternalStore } from 'react';
import {
  parseRoute,
  route,
  type RouteState,
  type RouteSelection,
} from './routing';
function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
function snapshot(): string {
  return window.location.hash;
}
/** The URL owns browser-only navigation state, independently of Runtime and query data. */
export function useRoute(): RouteState {
  return parseRoute(useSyncExternalStore(subscribe, snapshot));
}
export function replaceRouteSelection(patch: Partial<RouteSelection>): void {
  const { id, view, candidate, artifact, ...selection } = parseRoute(
    window.location.hash,
  );
  const next = route(id, view, candidate, artifact, { ...selection, ...patch });
  window.history.replaceState(window.history.state, '', next);
  window.dispatchEvent(new Event('hashchange'));
}
