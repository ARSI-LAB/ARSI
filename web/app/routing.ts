export interface RouteSelection {
  candidateCell?: string;
  learning?: string;
  revision?: string;
  diffFile?: string;
  point?: string;
  content?: string;
  display?: string;
  call?: string;
  measurement?: string;
  file?: string;
  directory?: string;
  search?: string;
  status?: string;
  offset?: number;
  fileSearch?: string;
  scope?: string;
  metric?: string;
  condition?: string;
  statistic?: string;
  chartOffset?: number;
}
export interface RouteState extends RouteSelection {
  id: string | null;
  view: string;
  candidate?: string;
  artifact?: string;
}
const textKeys = [
  'candidateCell',
  'learning',
  'revision',
  'diffFile',
  'point',
  'content',
  'display',
  'call',
  'measurement',
  'file',
  'directory',
  'search',
  'status',
  'fileSearch',
  'scope',
  'metric',
  'condition',
  'statistic',
] as const;
export function route(
  id: string | null,
  view = 'overview',
  candidate?: string,
  artifact?: string,
  selection: RouteSelection = {},
): string {
  const params = new URLSearchParams({
    ...(id ? { experiment: id, view } : {}),
    ...(candidate ? { candidate } : {}),
    ...(artifact ? { artifact } : {}),
  });
  for (const key of textKeys)
    if (selection[key]) params.set(key, selection[key]);
  for (const key of ['offset', 'chartOffset'] as const) {
    const value = selection[key];
    if (value !== undefined && Number.isSafeInteger(value) && value > 0)
      params.set(key, String(value));
  }
  return '#' + params.toString();
}
export function parseRoute(hash: string): RouteState {
  const params = new URLSearchParams(hash.slice(1));
  const state: RouteState = {
    id: params.get('experiment'),
    view:
      params.get('view') === 'configuration'
        ? 'recipe'
        : (params.get('view') ?? 'overview'),
    candidate: params.get('candidate') ?? undefined,
    artifact: params.get('artifact') ?? undefined,
  };
  for (const key of textKeys) {
    const value = params.get(key);
    if (value) state[key] = value;
  }
  for (const key of ['offset', 'chartOffset'] as const) {
    const raw = params.get(key);
    if (raw && /^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isSafeInteger(value)) state[key] = value;
    }
  }
  return state;
}
