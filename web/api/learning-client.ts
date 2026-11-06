export interface LearningRecord {
  id: string;
  binding: string;
  kind: string;
  parentRef: string | null;
  resourceRef: string | null;
  reason: string | null;
  status: string;
  path: string | null;
  startedAt: string | null;
}
export interface ApplicationPreview {
  applicationAllowed: boolean;
  restrictions: string[];
  changes: { action: string; path: string; kind: string }[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid learning response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid learning response field');
  return value;
}
function optional(value: unknown): string | null {
  return value == null ? null : text(value);
}
export function parseLearning(raw: unknown): LearningRecord[] {
  if (!Array.isArray(raw)) throw new Error('Invalid learning records');
  return raw.map((value) => {
    const item = record(value);
    return {
      id: text(item.id),
      binding: text(item.binding),
      kind: text(item.kind),
      parentRef: optional(item.parentRef),
      resourceRef: optional(item.resourceRef),
      reason: optional(item.reason),
      status: text(item.status),
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
export async function applyRevision(
  id: string,
  ref: string,
): Promise<'applied' | 'unchanged'> {
  const response = await fetch(
    `api/experiments/${encodeURIComponent(id)}/revisions/${encodeURIComponent(ref)}/apply`,
    { method: 'POST', signal: AbortSignal.timeout(120000) },
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
