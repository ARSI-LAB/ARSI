import type {
  ExperimentDetails,
  ArtifactPreview,
  CallDetail,
  CallSummary,
  CandidateSummary,
  ExperimentOverview,
  ExperimentSummary,
  JsonPreview,
  MeasurementSummary,
  MetricObservation,
  MetricRecord,
  Page,
} from '../../src/contracts/observation.js';
export type {
  ArtifactPreview,
  MetricObservation,
  ResultReference,
  CallDetail,
  CallSummary,
  CandidateSummary,
  ExperimentOverview,
  ExperimentSummary,
  JsonPreview,
  MeasurementSummary,
  MetricRecord,
  Page,
} from '../../src/contracts/observation.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid observation response');
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid text in observation response');
  return value;
}
function nullable(value: unknown): string | null {
  return value === null ? null : text(value);
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Invalid number in observation response');
  return value;
}
function array<T>(value: unknown, parse: (raw: unknown) => T): T[] {
  if (!Array.isArray(value))
    throw new Error('Invalid list in observation response');
  return value.map(parse);
}
function numbers(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => [key, number(item)]),
  );
}
function preview(value: unknown): JsonPreview | null {
  if (value === null) return null;
  const data = record(value);
  if (typeof data.truncated !== 'boolean')
    throw new Error('Invalid preview response');
  return { text: text(data.text), truncated: data.truncated };
}
export function parsePage<T>(
  parse: (raw: unknown) => T,
): (raw: unknown) => Page<T> {
  return (raw) => {
    const data = record(raw),
      total = number(data.total),
      nextOffset = data.nextOffset === null ? null : number(data.nextOffset);
    if (
      !Number.isInteger(total) ||
      total < 0 ||
      (nextOffset !== null && (!Number.isInteger(nextOffset) || nextOffset < 0))
    )
      throw new Error('Invalid pagination response');
    return { items: array(data.items, parse), total, nextOffset };
  };
}
export function parseExperiment(raw: unknown): ExperimentSummary {
  const data = record(raw);
  return {
    id: text(data.id),
    recipeId: nullable(data.recipeId),
    status: text(data.status),
    startedAt: nullable(data.startedAt),
    finishedAt: nullable(data.finishedAt),
    error: nullable(data.error),
  };
}
export function parseOverview(raw: unknown): ExperimentOverview {
  const data = record(raw);
  return {
    ...parseExperiment(data),
    observedAt: text(data.observedAt),
    usage: data.usage === null ? null : numbers(data.usage),
    limits: numbers(data.limits),
    output: preview(data.output),
  };
}
function parseCall(raw: unknown): CallSummary {
  const data = record(raw);
  return {
    callId: text(data.callId),
    parentCallId: nullable(data.parentCallId),
    bindingId: text(data.bindingId),
    pluginId: text(data.pluginId),
    path: nullable(data.path),
    status: text(data.status),
    startedAt: nullable(data.startedAt),
    finishedAt: nullable(data.finishedAt),
    error: nullable(data.error),
  };
}
export function parseCallDetail(raw: unknown): CallDetail {
  const data = record(raw);
  return {
    ...parseCall(data),
    input: preview(data.input),
    output: preview(data.output),
  };
}
function parseCandidate(raw: unknown): CandidateSummary {
  const data = record(raw);
  return {
    ref: text(data.ref),
    parentRef: nullable(data.parentRef),
    artifactRef: text(data.artifactRef),
  };
}
function parseMetric(raw: unknown): MetricObservation {
  const data = record(raw);
  return {
    name: text(data.name),
    definitionRef: text(data.definitionRef),
    unit: text(data.unit),
    description: text(data.description),
    status: text(data.status),
    reason: nullable(data.reason),
    values: Object.fromEntries(
      Object.entries(record(data.values)).map(([key, value]) => [
        key,
        value === null ? null : number(value),
      ]),
    ),
  };
}
function parseMeasurement(raw: unknown): MeasurementSummary {
  const data = record(raw);
  return {
    ref: text(data.ref),
    candidateRef: text(data.candidateRef),
    callId: text(data.callId),
    status: text(data.status),
    coverage: text(data.coverage),
    comparisonKey: nullable(data.comparisonKey),
    startedAt: nullable(data.startedAt),
    finishedAt: nullable(data.finishedAt),
    metrics: array(data.metrics, parseMetric),
  };
}
export const parseMetricRecords = parsePage((raw: unknown): MetricRecord => {
  const data = record(raw);
  const item = data.item === null ? null : record(data.item);
  return {
    ...parseMeasurement(data),
    item: item
      ? {
          id: text(item.id),
          subjectKind: text(item.subjectKind),
          subjectId: text(item.subjectId),
          parametersRef: nullable(item.parametersRef),
        }
      : null,
  };
});
export const parseExperiments = parsePage(parseExperiment);
export const parseCalls = parsePage(parseCall);
export const parseCandidates = parsePage(parseCandidate);
export const parseMeasurements = parsePage(parseMeasurement);

/** This client has no mutation methods. Validate network data before rendering. */
export async function readObservation<T>(
  path: string,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/observation/experiments' + path, {
    method: 'GET',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof record(value).error === 'string'
        ? text(record(value).error)
        : `Request failed (${response.status})`,
    );
  return parse(value);
}

export function parseDetails(raw: unknown): ExperimentDetails {
  const data = record(raw);
  return {
    configuration: preview(data.configuration),
    result: preview(data.result),
    resultReferences: array(data.resultReferences, (raw) => {
      const reference = record(raw);
      if (reference.kind !== 'candidate' && reference.kind !== 'measurement')
        throw new Error('Invalid result reference kind');
      return {
        kind: reference.kind,
        ref: text(reference.ref),
        path: text(reference.path),
      };
    }),
  };
}
export function parseArtifact(raw: unknown): ArtifactPreview {
  const data = record(raw);
  if (data.kind !== 'json' && data.kind !== 'file-tree')
    throw new Error('Invalid artifact kind');
  return {
    ref: text(data.ref),
    kind: data.kind,
    content: preview(data.content),
    unavailable: nullable(data.unavailable),
    files:
      data.files === null
        ? null
        : parsePage((raw) => {
            const file = record(raw);
            return { path: text(file.path), bytes: number(file.bytes) };
          })(data.files),
  };
}
