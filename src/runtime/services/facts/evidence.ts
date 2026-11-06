import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { evaluationFeedbackSchema } from '../../../contracts/models/measurement.js';
import { validate } from '../../../shared/schema.js';
import { secretValues, redactText } from '../../../shared/secrets.js';

export type EvidenceView = 'execution' | 'training-summary' | 'delivery';
export interface EvidenceProjectionOptions {
  /** The caller has already resolved and authorized these Measurement records. */
  measurements: JsonObject[];
  artifacts: ArtifactStore;
  view: EvidenceView;
  maxBytes?: number;
}
async function trainingItems(
  measurement: JsonObject,
  artifacts: ArtifactStore,
  budget: number,
  secrets: string[],
): Promise<JsonObject> {
  const output: JsonObject = {
    items: [],
    metricDefinitions: {},
    omittedItems: 0,
    itemsTruncated: false,
    metricDefinitionsOmitted: false,
  };
  const aggregateDefinitions: JsonObject = {};
  for (const metric of Object.values(object(measurement.metrics ?? {}))) {
    if (isObject(metric) && typeof metric.definitionRef === 'string')
      aggregateDefinitions[metric.definitionRef] = await artifacts.readJson(
        metric.definitionRef,
      );
  }
  output.metricDefinitions = aggregateDefinitions;
  if (size(output) > budget) {
    output.metricDefinitions = {};
    output.metricDefinitionsOmitted = true;
    output.itemsTruncated = true;
  }
  if (typeof measurement.itemsRef !== 'string') return output;
  const catalog = object(await artifacts.readJson(measurement.itemsRef));
  if (!Array.isArray(catalog.items))
    throw new Error('Invalid Measurement items');
  const projected = output.items as JsonObject[];
  for (let index = 0; index < catalog.items.length; index++) {
    const item = object(catalog.items[index]);
    const evaluation =
      item.evaluation === null || item.evaluation === undefined
        ? null
        : object(item.evaluation);
    const feedback = evaluation
      ? object(await artifacts.readJson(string(evaluation.artifactRef)))
      : null;
    if (feedback)
      validate(
        evaluationFeedbackSchema,
        feedback,
        'training evaluation feedback',
      );
    if (feedback?.truncated === true) output.itemsTruncated = true;
    const definitions: JsonObject = {};
    for (const metric of Object.values(object(item.metrics ?? {}))) {
      if (isObject(metric) && typeof metric.definitionRef === 'string')
        definitions[metric.definitionRef] = await artifacts.readJson(
          metric.definitionRef,
        );
    }
    const value: JsonObject = {
      id: item.id ?? null,
      subject: item.subject ?? null,
      metrics: item.metrics ?? {},
      evaluation: feedback,
      evaluationRef: evaluation?.artifactRef ?? null,
      omittedChecks: 0,
      omittedDiagnostics: 0,
    };
    // Normalized feedback is allowlisted by its schema; do not scrub away score/reward keys.
    const safe = (v: JsonValue): JsonValue => {
      if (typeof v === 'string') return redactText(v, secrets);
      if (Array.isArray(v)) return v.map(safe);
      if (v !== null && typeof v === 'object')
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, safe(x)]),
        );
      return v;
    };
    const priorDefinitions = object(output.metricDefinitions);
    output.metricDefinitions = { ...priorDefinitions, ...definitions };
    projected.push(value);
    while (
      size(output) > budget &&
      feedback &&
      (feedback.diagnostics as JsonValue[]).length
    ) {
      (feedback.diagnostics as JsonValue[]).pop();
      value.omittedDiagnostics = Number(value.omittedDiagnostics) + 1;
      feedback.truncated = true;
      output.itemsTruncated = true;
    }
    while (
      size(output) > budget &&
      feedback &&
      (feedback.checks as JsonValue[]).length
    ) {
      (feedback.checks as JsonValue[]).pop();
      value.omittedChecks = Number(value.omittedChecks) + 1;
      feedback.truncated = true;
      output.itemsTruncated = true;
    }
    if (size(output) > budget) {
      projected.pop();
      output.metricDefinitions = priorDefinitions;
      output.omittedItems = catalog.items.length - index;
      output.itemsTruncated = true;
      break;
    }
    projected[projected.length - 1] = object(safe(value));
  }
  return output;
}
interface ScrubState {
  redacted: boolean;
  truncated: boolean;
}
const size = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = (key: string): boolean =>
  ['__proto__', 'constructor', 'prototype'].includes(key) ||
  /score|reward|passed|successrate|correctness|verdict|grader|grading|judge|groundtruth|expectedanswer|expectedoutput|referenceanswer|private|secret|password|apikey|authorization|credential|metrics|candidateref|candidateid|measurementref|attemptid|itemid/.test(
    key.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
function scrub(
  value: JsonValue,
  secrets: string[],
  state: ScrubState,
): JsonValue {
  if (typeof value === 'string') {
    const text = redactText(value, secrets);
    if (text !== value) state.redacted = true;
    return text;
  }
  if (Array.isArray(value))
    return value.map((item) => scrub(item, secrets, state));
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (forbidden(key)) {
        state.redacted = true;
        continue;
      }
      result[key] = scrub(entry, secrets, state);
    }
    return result;
  }
  return value;
}
/** Full text projection retains all lines while applying the execution-view redaction rules. */
export function fullEvidenceText(
  text: string,
  format: 'text' | 'json' | 'jsonl',
): { text: string; redacted: boolean; truncated: boolean } {
  const secrets = secretValues();
  let redacted = false,
    truncated = false;
  const clean = (line: string): string => {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return redactText(line, secrets);
    }
    const state: ScrubState = { redacted: false, truncated: false };
    const value = scrub(parsed, secrets, state);
    redacted ||= state.redacted;
    truncated ||= state.truncated;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  const content =
    format === 'jsonl'
      ? text.split('\n').map(clean).join('\n')
      : format === 'json'
        ? clean(text)
        : redactText(text, secrets);
  return {
    text: content,
    redacted: redacted || content.includes('[REDACTED]'),
    truncated,
  };
}
function textPrefix(text: string, limit: number): string {
  let low = 0,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(text.slice(0, middle)) <= Math.max(0, limit)) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}
function textPreview(
  text: string,
  budget: number,
  secrets: string[],
  structured: boolean,
): JsonObject {
  const state: ScrubState = { redacted: false, truncated: false };
  if (!structured) {
    const redacted = redactText(text, secrets);
    const excerpt = textPrefix(redacted, Math.max(0, budget - 180));
    return {
      text: excerpt,
      source: { segment: 'prefix', inputCharacters: text.length },
      truncated: excerpt.length < redacted.length,
      redacted: redacted !== text,
    };
  }
  const lines = text.split(/\r?\n/);
  const sampled = new Set<number>();
  // Head and tail preserve startup context and the final failure/completion observations.
  for (let i = 0; i < Math.min(4, lines.length); i++) sampled.add(i);
  for (let i = Math.max(0, lines.length - 6); i < lines.length; i++)
    sampled.add(i);
  const snippets: JsonValue[] = [];
  const perLine = Math.max(
    0,
    Math.floor((budget - 250) / Math.max(1, sampled.size)) - 100,
  );
  let omittedLines = lines.length - sampled.size;
  for (const index of [...sampled].sort((a, b) => a - b)) {
    if (perLine < 16) {
      omittedLines++;
      continue;
    }
    let value: JsonValue;
    try {
      value = JSON.parse(lines[index]) as JsonValue;
    } catch {
      value = lines[index];
    }
    const sanitized = scrub(value, secrets, state);
    const rendered =
      typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
    const excerpt = textPrefix(rendered, perLine);
    snippets.push({
      source: { lineStart: index + 1, lineEnd: index + 1 },
      text: excerpt,
      truncated: excerpt.length < rendered.length,
    });
    if (excerpt.length < rendered.length) state.truncated = true;
  }
  return {
    snippets,
    omittedLines,
    redacted: state.redacted,
    truncated: omittedLines > 0 || state.truncated,
  };
}
async function projectEntry(
  entry: JsonObject,
  artifacts: ArtifactStore,
  view: EvidenceView,
  budget: number,
  secrets: string[],
): Promise<JsonObject> {
  const kind = string(entry.kind);
  const artifactRef =
    typeof entry.artifactRef === 'string' ? entry.artifactRef : null;
  const source: JsonObject = { artifactRef };
  if (view !== 'delivery') {
    if (typeof entry.itemId === 'string') source.itemId = entry.itemId;
    if (typeof entry.attemptId === 'string') source.attemptId = entry.attemptId;
  }
  const projected: JsonObject = {
    kind,
    source,
    integrity: entry.integrity ?? 'unknown',
    truncated: false,
  };
  if (
    !artifactRef ||
    entry.integrity === 'missing' ||
    entry.integrity === 'not-produced'
  )
    return { ...projected, inspection: 'unavailable' };
  let raw: JsonValue;
  try {
    raw = await artifacts.readJson(artifactRef);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return {
        ...projected,
        inspection: 'unavailable',
        omitted: true,
        truncated: true,
      };
    throw error;
  }
  if (isObject(raw) && raw.kind === 'file-tree') {
    const tree = parseFileTree(raw);
    const files: JsonValue[] = [];
    const count = tree.files.length;
    let omittedFiles = 0;
    const perFile = Math.max(
      0,
      Math.floor((budget - 220) / Math.max(1, Math.min(count, 8))) - 150,
    );
    for (let index = 0; index < count; index++) {
      if (index >= 8) {
        omittedFiles++;
        continue;
      }
      const file = tree.files[index]!;
      const path = file.path;
      const bytes = Buffer.from(file.base64, 'base64');
      let decoded: string | null = null;
      if (!bytes.includes(0)) {
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          /* Binary evidence remains explicitly uninspected. */
        }
      }
      const item: JsonObject = {
        path: redactText(path, secrets),
        sizeBytes: bytes.length,
        source: {
          artifactRef,
          pointer: `/files/${index}`,
          path: redactText(path, secrets),
        },
        inspection: decoded === null ? 'uninspected' : 'text-excerpt',
      };
      if (decoded !== null && perFile >= 120) {
        item.preview = textPreview(
          decoded,
          perFile,
          secrets,
          kind === 'trajectory' || /\.(jsonl|ndjson|json)$/.test(path),
        );
      } else if (decoded !== null) {
        item.inspection = 'uninspected';
        item.omitted = true;
      }
      files.push(item);
    }
    projected.files = files;
    projected.omittedFiles = omittedFiles;
    projected.truncated =
      omittedFiles > 0 ||
      files.some((value) => {
        const file = object(value);
        return (
          file.omitted === true ||
          (isObject(file.preview) && file.preview.truncated === true)
        );
      });
  } else {
    const state: ScrubState = { redacted: false, truncated: false };
    const sanitized = scrub(raw, secrets, state);
    const text =
      isObject(sanitized) && typeof sanitized.text === 'string'
        ? sanitized.text
        : typeof sanitized === 'string'
          ? sanitized
          : JSON.stringify(sanitized);
    projected.preview = textPreview(
      text,
      Math.max(0, budget - 220),
      secrets,
      kind === 'trajectory',
    );
    projected.redacted = state.redacted;
    projected.truncated =
      state.truncated || object(projected.preview).truncated === true;
  }
  // Metadata and heavily escaped JSON can exceed estimates. Remove content, never silently overrun.
  if (size(projected) > budget) {
    if (Array.isArray(projected.files)) {
      for (const rawFile of projected.files) {
        const file = object(rawFile);
        delete file.preview;
        file.inspection = 'uninspected';
        file.omitted = true;
      }
      while (projected.files.length && size(projected) > budget) {
        projected.files.pop();
        projected.omittedFiles = Number(projected.omittedFiles ?? 0) + 1;
      }
    } else {
      delete projected.preview;
      projected.inspection = 'uninspected';
      projected.omitted = true;
    }
    projected.truncated = true;
  }
  return projected;
}

/** Projects authorized records only; references and access checks belong to the caller. */
export async function projectEvidence(
  options: EvidenceProjectionOptions,
): Promise<JsonValue> {
  const { measurements, artifacts, view } = options;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (!['execution', 'training-summary', 'delivery'].includes(view))
    throw new Error('Unknown evidence view');
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
  )
    throw new Error('Evidence budget must be a positive safe integer');
  for (const measurement of measurements) {
    if (
      measurement.schemaVersion !== 'rsi.measurement/v1' ||
      typeof measurement.evidenceIndexRef !== 'string' ||
      typeof measurement.ref !== 'string' ||
      measurement.ref.startsWith('artifact:')
    )
      throw new Error(
        'Evidence projection requires authorized Measurement records',
      );
  }
  const output: JsonObject = {
    schemaVersion: 'rsi.evidence-view/v1',
    view,
    measurements: [],
    truncated: false,
    omittedMeasurements: 0,
  };
  const projected = output.measurements as JsonValue[];
  const secrets = secretValues();
  if (view === 'delivery')
    for (const measurement of measurements)
      for (const key of ['ref', 'candidateRef', 'experimentId', 'callId']) {
        const value = measurement[key];
        if (typeof value === 'string' && value.length >= 8) secrets.push(value);
      }
  for (let index = 0; index < measurements.length; index++) {
    const measurement = measurements[index];
    const remaining = maxBytes - size(output) - 64;
    if (remaining < 180) {
      output.truncated = true;
      output.omittedMeasurements = measurements.length - index;
      break;
    }
    const quota = Math.floor(
      remaining / Math.max(1, measurements.length - index),
    );
    const result: JsonObject = {
      evidence: [],
      truncated: false,
      omittedEntries: 0,
    };
    if (view !== 'delivery') {
      result.measurementRef = measurement.ref;
      result.status = measurement.status ?? 'unknown';
      result.coverage = measurement.coverage ?? 'unknown';
    }
    if (view === 'training-summary' && measurement.metrics !== undefined) {
      if (size(measurement.metrics) < quota / 3)
        result.metrics = measurement.metrics;
      else {
        result.metricsOmitted = true;
        result.truncated = true;
      }
      const training = await trainingItems(
        measurement,
        artifacts,
        Math.max(0, Math.floor(quota * 0.65) - size(result)),
        secrets,
      );
      Object.assign(result, training);
      if (training.itemsTruncated === true) result.truncated = true;
    }
    const catalog = object(
      await artifacts.readJson(string(measurement.evidenceIndexRef)),
    );
    if (!Array.isArray(catalog.entries))
      throw new Error('Invalid Measurement evidence index');
    const entries = catalog.entries
      .map((value) => object(value))
      .filter(
        (entry) =>
          ['execution', 'delivery'].includes(String(entry.access)) &&
          ['trajectory', 'final-text', 'delivery'].includes(
            String(entry.kind),
          ) &&
          (view !== 'delivery' || entry.kind === 'delivery'),
      );
    const evidence = result.evidence as JsonValue[];
    for (let ordinal = 0; ordinal < entries.length; ordinal++) {
      const available = quota - size(result) - 100;
      const allocation = Math.floor(
        available / Math.max(1, entries.length - ordinal),
      );
      if (allocation < 160) {
        result.omittedEntries = entries.length - ordinal;
        result.truncated = true;
        break;
      }
      const entry = await projectEntry(
        entries[ordinal],
        artifacts,
        view,
        allocation,
        secrets,
      );
      if (size(entry) > available) {
        result.omittedEntries = Number(result.omittedEntries) + 1;
        result.truncated = true;
        continue;
      }
      evidence.push(entry);
      if (entry.truncated === true) result.truncated = true;
    }
    projected.push(result);
    while (size(output) > maxBytes && evidence.length) {
      evidence.pop();
      result.omittedEntries = Number(result.omittedEntries) + 1;
      result.truncated = true;
    }
    if (size(output) > maxBytes) {
      projected.pop();
      output.omittedMeasurements = measurements.length - index;
      output.truncated = true;
      break;
    }
    if (result.truncated === true) output.truncated = true;
  }
  if (size(output) > maxBytes)
    throw new Error('Evidence context exceeds byte limit');
  return output;
}
