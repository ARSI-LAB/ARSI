export interface EvolutionRecord {
  id: string;
  binding: string | null;
  bindings: string[];
  changedBindings: string[];
  depth: number;
  kind: string;
  parentRef: string | null;
  resourceRef: string | null;
  parentArtifactRef: string | null;
  callId: string | null;
  reason: string | null;
  status: string;
  inProgress: boolean;
  path: string | null;
  startedAt: string | null;
}
export interface ApplicationPreview {
  applicationAllowed: boolean;
  restrictions: string[];
  destinations: string[];
  changes: { action: string; path: string; kind: string }[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid evolution response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid evolution response field');
  return value;
}
function optional(value: unknown): string | null {
  return value == null ? null : text(value);
}
export function parseEvolution(raw: unknown): EvolutionRecord[] {
  if (!Array.isArray(raw)) throw new Error('Invalid evolution records');
  return raw.map((value) => {
    const item = record(value);
    return {
      id: text(item.id),
      binding: optional(item.binding),
      bindings: Array.isArray(item.bindings) ? item.bindings.map(text) : [],
      changedBindings: Array.isArray(item.changedBindings)
        ? item.changedBindings.map(text)
        : [],
      depth: typeof item.depth === 'number' ? item.depth : 0,
      kind: text(item.kind),
      parentRef: optional(item.parentRef),
      resourceRef: optional(item.resourceRef),
      parentArtifactRef: optional(item.parentArtifactRef),
      callId: optional(item.callId),
      reason: optional(item.reason),
      status: text(item.status),
      inProgress: item.inProgress === true,
      path: optional(item.path),
      startedAt: optional(item.startedAt),
    };
  });
}
export function parseApplication(raw: unknown): ApplicationPreview {
  const item = record(raw);
  if (
    typeof item.applicationAllowed !== 'boolean' ||
    !Array.isArray(item.restrictions) ||
    !Array.isArray(item.changes)
  )
    throw new Error('Invalid application preview');
  return {
    applicationAllowed: item.applicationAllowed,
    restrictions: item.restrictions.map(text),
    destinations: Array.isArray(item.destinations)
      ? item.destinations.map((entry) => text(record(entry).path))
      : [],
    changes: item.changes.map((value) => {
      const change = record(value);
      return {
        action: text(change.action),
        path: text(change.path),
        kind: optional(change.kind) ?? 'file',
      };
    }),
  };
}
/** Never retry a write automatically: a lost response may follow a completed application. */
export async function applySnapshot(
  id: string,
  collection: 'memories' | 'revisions',
  ref: string,
  to?: string,
): Promise<'applied' | 'unchanged'> {
  const response = await fetch(
    `api/experiments/${encodeURIComponent(id)}/${collection}/${encodeURIComponent(ref)}/apply`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      ...(to
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetDir: to }),
          }
        : {}),
    },
  );
  const data = record(await response.json());
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Application failed',
    );
  if (data.status !== 'applied' && data.status !== 'unchanged')
    throw new Error(
      'Unknown application outcome. Refresh the preview before retrying.',
    );
  return data.status;
}
