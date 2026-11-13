import { connectionError, setDisconnected } from './connection-state.js';
import type { JsonValue } from '../../src/contracts/json.js';
import { isStructureRangePreviewBounds } from '../../src/shared/observation/policy-range-preview.js';
import type {
  PolicyStructure,
  StructureExpressionPreview,
} from '../../src/shared/observation/policy-structure.js';
export type {
  PolicyStructure,
  StructureDataEdge,
  StructureDataNode,
  StructureDetail,
  StructureFlowEdge,
  StructureStep,
} from '../../src/shared/observation/policy-structure.js';
import type {
  CallTrace,
  CallInstructions,
  ObservationSource,
} from '../../src/contracts/observation.js';
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
    triggerPath: data.triggerPath == null ? null : text(data.triggerPath),
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
    originPath:
      data.originPath === undefined ? null : nullable(data.originPath),
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
  return readProjection('api/observation/experiments' + path, parse, signal);
}
export async function readObservationSource(
  signal?: AbortSignal,
): Promise<ObservationSource> {
  return readProjection(
    'api/observation/source',
    (raw) => ({ directory: nullable(record(raw).directory) }),
    signal,
  );
}
async function readProjection<T>(
  url: string,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    setDisconnected(true);
    throw new Error(connectionError);
  }
  if ([502, 503, 504].includes(response.status)) {
    setDisconnected(true);
    throw new Error(connectionError);
  }
  setDisconnected(false);
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
            return {
              path: text(file.path),
              bytes: number(file.bytes),
              ...(file.digest === undefined
                ? {}
                : { digest: text(file.digest) }),
            };
          })(data.files),
  };
}

export function parseCallTrace(raw: unknown): CallTrace {
  const data = record(raw);
  if (
    !Array.isArray(data.items) ||
    typeof data.incomplete !== 'boolean' ||
    typeof data.total !== 'number' ||
    (data.nextOffset !== null && typeof data.nextOffset !== 'number')
  )
    throw new Error('Invalid trace response');
  return {
    total: data.total,
    nextOffset: data.nextOffset,
    incomplete: data.incomplete,
    unavailable: nullable(data.unavailable),
    items: data.items.map((raw) => {
      const item = record(raw);
      if (typeof item.sequence !== 'number')
        throw new Error('Invalid trace sequence');
      return {
        sequence: item.sequence,
        at: nullable(item.at),
        type: text(item.type),
        content: preview(item.content),
      };
    }),
  };
}

export function parseCallInstructions(raw: unknown): CallInstructions {
  return { prompt: preview(record(raw).prompt) };
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  const result = values.find((candidate) => candidate === value);
  if (result === undefined) throw new Error('Invalid Policy structure value');
  return result;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return number(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => [key, jsonValue(item)]),
  );
}

function parseStructureExpressionPreview(
  raw: unknown,
): StructureExpressionPreview {
  const item = record(raw);
  const location = text(item.location);
  const kind = choice(item.kind, ['config', 'value', 'range']);
  if (kind === 'config')
    return { location, kind, path: array(item.path, text) };
  if (kind === 'value') return { location, kind, value: jsonValue(item.value) };
  const start = number(item.start);
  const end = number(item.end);
  if (!isStructureRangePreviewBounds(start, end))
    throw new Error('Invalid Policy range preview bounds');
  return { location, kind, start, end };
}

/** Validate the single saved-definition response before graph layout or rendering. */
export function parsePolicyStructure(raw: unknown): PolicyStructure {
  const value = record(raw);
  const source = record(value.source);
  const availability = record(value.availability);
  const flow = record(value.flow);
  const data = record(value.data);
  const states = ['complete', 'partial', 'unavailable'] as const;
  const endpoint = (raw: unknown): { nodeId: string; portId: string } => {
    const item = record(raw);
    return { nodeId: text(item.nodeId), portId: text(item.portId) };
  };
  const model: PolicyStructure = {
    source: {
      experimentId: text(source.experimentId),
      policyId: nullable(source.policyId),
      definitionDigest: nullable(source.definitionDigest),
      snapshot: choice(source.snapshot, ['initial']),
    },
    availability: {
      overall: choice(availability.overall, states),
      flow: choice(availability.flow, states),
      data: choice(availability.data, states),
      details: choice(availability.details, states),
    },
    steps: array(value.steps, (raw) => {
      const item = record(raw);
      return {
        id: text(item.id),
        localId: text(item.localId),
        label: text(item.label),
        type: choice(item.type, [
          'invoke',
          'state',
          'if',
          'loop',
          'foreach',
          'control',
          'reflection',
        ]),
        location: text(item.location),
        scopeId: text(item.scopeId),
        childScopeIds: array(item.childScopeIds, text),
        detailId: text(item.detailId),
      };
    }),
    scopes: array(value.scopes, (raw) => {
      const item = record(raw);
      return {
        id: text(item.id),
        parentStepId: nullable(item.parentStepId),
        region: choice(item.region, [
          'root',
          'then',
          'else',
          'iteration',
          'item',
        ]),
        location: text(item.location),
        stepIds: array(item.stepIds, text),
        entryId: text(item.entryId),
        exitId: text(item.exitId),
      };
    }),
    flow: {
      nodes: array(flow.nodes, (raw) => {
        const item = record(raw);
        return {
          id: text(item.id),
          kind: choice(item.kind, ['step', 'entry', 'exit', 'failure']),
          stepId: nullable(item.stepId),
          scopeId: text(item.scopeId),
          label: text(item.label),
        };
      }),
      edges: array(flow.edges, (raw) => {
        const item = record(raw);
        return {
          id: text(item.id),
          source: text(item.source),
          target: text(item.target),
          kind: choice(item.kind, [
            'sequence',
            'branch',
            'repetition',
            'break',
            'continue',
            'fail',
          ]),
          label: nullable(item.label),
          location: text(item.location),
        };
      }),
    },
    data: {
      nodes: array(data.nodes, (raw) => {
        const item = record(raw);
        return {
          id: text(item.id),
          kind: choice(item.kind, [
            'step',
            'input',
            'config',
            'state',
            'output',
            'application',
            'loop',
            'item',
          ]),
          stepId: nullable(item.stepId),
          label: text(item.label),
          scopeId: text(item.scopeId),
          detailId: text(item.detailId),
          ports: array(item.ports, (raw) => {
            const port = record(raw);
            return {
              id: text(port.id),
              label: text(port.label),
              role: choice(port.role, [
                'field',
                'input',
                'output',
                'expression',
              ]),
              path: array(port.path, text),
              location: text(port.location),
            };
          }),
        };
      }),
      edges: array(data.edges, (raw) => {
        const item = record(raw);
        if (typeof item.dynamic !== 'boolean')
          throw new Error('Invalid Policy dynamic reference');
        return {
          id: text(item.id),
          source: endpoint(item.source),
          target: endpoint(item.target),
          kind: choice(item.kind, [
            'reference',
            'state-write',
            'item-binding',
            'output-mapping',
          ]),
          dynamic: item.dynamic,
          label: nullable(item.label),
          location: text(item.location),
        };
      }),
    },
    details: array(value.details, (raw) => {
      const item = record(raw);
      return {
        id: text(item.id),
        declaration: jsonValue(item.declaration),
        configuration: jsonValue(item.configuration),
        bindingId: nullable(item.bindingId),
        ...(item.expressionPreviews === undefined
          ? {}
          : {
              expressionPreviews: array(
                item.expressionPreviews,
                parseStructureExpressionPreview,
              ),
            }),
      };
    }),
    bindings: array(value.bindings, (raw) => {
      const item = record(raw);
      return {
        id: text(item.id),
        name: text(item.name),
        contract: nullable(item.contract),
        plugin: nullable(item.plugin),
        ...(item.pluginDescription === undefined
          ? {}
          : { pluginDescription: text(item.pluginDescription) }),
        configuration: jsonValue(item.configuration),
      };
    }),
    diagnostics: array(value.diagnostics, (raw) => {
      const item = record(raw);
      return {
        category: choice(item.category, [
          'missing-source',
          'unsupported-source',
          'invalid-source',
          'analysis',
          'oversized',
        ]),
        view: choice(item.view, ['all', 'flow', 'data', 'details']),
        nodeId: nullable(item.nodeId),
        location: nullable(item.location),
        message: text(item.message),
      };
    }),
  };
  validateStructureLinks(model);
  return model;
}

function validateStructureLinks(model: PolicyStructure): void {
  const index = <T extends { id: string }>(items: T[]): Map<string, T> => {
    const result = new Map(items.map((item) => [item.id, item]));
    if (result.size !== items.length)
      throw new Error('Duplicate Policy structure identity');
    return result;
  };
  const steps = index(model.steps),
    scopes = index(model.scopes),
    flow = index(model.flow.nodes),
    data = index(model.data.nodes);
  const ports = new Map(
    model.data.nodes.map((node) => [node.id, index(node.ports)]),
  );
  index(model.flow.edges);
  index(model.data.edges);
  index(model.details);
  index(model.bindings);
  const invalid = (): never => {
    throw new Error('Invalid Policy structure relationship');
  };
  for (const step of steps.values()) {
    if (!scopes.get(step.scopeId)?.stepIds.includes(step.id)) invalid();
    for (const scopeId of step.childScopeIds)
      if (scopes.get(scopeId)?.parentStepId !== step.id) invalid();
    const ancestors = new Set<string>();
    let parent: string | null = scopes.get(step.scopeId)?.parentStepId ?? null;
    while (parent !== null) {
      if (parent === step.id || ancestors.has(parent)) invalid();
      ancestors.add(parent);
      const owner = steps.get(parent);
      if (!owner) throw new Error('Invalid Policy scope owner');
      parent = scopes.get(owner.scopeId)?.parentStepId ?? null;
    }
  }
  for (const scope of scopes.values()) {
    if (
      (scope.parentStepId !== null && !steps.has(scope.parentStepId)) ||
      scope.stepIds.some((id) => steps.get(id)?.scopeId !== scope.id)
    )
      invalid();
  }
  for (const edge of model.flow.edges)
    if (!flow.has(edge.source) || !flow.has(edge.target)) invalid();
  for (const edge of model.data.edges) {
    for (const endpoint of [edge.source, edge.target])
      if (
        !data.has(endpoint.nodeId) ||
        !ports.get(endpoint.nodeId)?.has(endpoint.portId)
      )
        invalid();
  }
}
