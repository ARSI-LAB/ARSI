import {
  evidenceRecordContent,
  scrub,
  scrubText,
  type ScrubState,
} from '../../../shared/evidence-redaction.js';
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { evaluationFeedbackSchema } from '../../../contracts/models/measurement.js';
import { validate } from '../../../shared/schema.js';
import {
  secretValues,
  redactText,
  redactJsonSecrets,
} from '../../../shared/secrets.js';
import {
  runtimeEvolutionEvidenceViews,
  type RuntimeEvolutionEvidenceView,
} from '../../../contracts/runtime-evolution.js';

export type EvidenceView = RuntimeEvolutionEvidenceView | 'delivery';
export interface EvidenceProjectionOptions {
  /** The caller has already resolved and authorized these Measurement records. */
  measurements: JsonObject[];
  artifacts: ArtifactStore;
  view: EvidenceView;
  maxBytes?: number;
  /** Skip execution previews when the caller supplies the full files alongside training feedback. */
  includeExecutionPreviews?: boolean;
}
/** Projects normalized feedback from an authorized Measurement, independently of its execution entries. */
export async function projectMeasurementTrainingFeedback(
  measurement: JsonObject,
  artifacts: ArtifactStore,
  budget: number,
  secrets: string[],
): Promise<JsonObject> {
  const output: JsonObject = {
    metrics: redactJsonSecrets(measurement.metrics ?? {}, secrets),
    items: [],
    metricDefinitions: {},
    omittedItems: 0,
    itemsTruncated: false,
    metricDefinitionsOmitted: false,
  };
  const exceedsBudget = () => Number.isFinite(budget) && size(output) > budget;
  if (exceedsBudget()) {
    delete output.metrics;
    output.metricsOmitted = true;
  }
  async function metricDefinitions(metrics: JsonValue): Promise<JsonObject> {
    const definitions: JsonObject = {};
    for (const metric of Object.values(object(metrics))) {
      if (isObject(metric) && typeof metric.definitionRef === 'string')
        definitions[metric.definitionRef] = redactJsonSecrets(
          await artifacts.readJson(metric.definitionRef),
          secrets,
        );
    }
    return definitions;
  }
  output.metricDefinitions = await metricDefinitions(measurement.metrics ?? {});
  if (exceedsBudget()) {
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
    const rawFeedback = evaluation
      ? object(await artifacts.readJson(string(evaluation.artifactRef)))
      : null;
    if (rawFeedback)
      validate(
        evaluationFeedbackSchema,
        rawFeedback,
        'training evaluation feedback',
      );
    const feedback =
      rawFeedback && object(redactJsonSecrets(rawFeedback, secrets));
    if (feedback?.truncated === true) output.itemsTruncated = true;
    const value: JsonObject = {
      id: redactJsonSecrets(item.id ?? null, secrets),
      subject: redactJsonSecrets(item.subject ?? null, secrets),
      metrics: redactJsonSecrets(item.metrics ?? {}, secrets),
      evaluation: feedback,
      evaluationRef: evaluation?.artifactRef ?? null,
      omittedChecks: 0,
      omittedDiagnostics: 0,
    };
    const priorDefinitions = object(output.metricDefinitions);
    output.metricDefinitions = {
      ...priorDefinitions,
      ...(await metricDefinitions(item.metrics ?? {})),
    };
    projected.push(value);
    while (
      feedback &&
      (feedback.diagnostics as JsonValue[]).length &&
      exceedsBudget()
    ) {
      (feedback.diagnostics as JsonValue[]).pop();
      value.omittedDiagnostics = Number(value.omittedDiagnostics) + 1;
      feedback.truncated = true;
      output.itemsTruncated = true;
    }
    while (
      feedback &&
      (feedback.checks as JsonValue[]).length &&
      exceedsBudget()
    ) {
      (feedback.checks as JsonValue[]).pop();
      value.omittedChecks = Number(value.omittedChecks) + 1;
      feedback.truncated = true;
      output.itemsTruncated = true;
    }
    if (exceedsBudget()) {
      projected.pop();
      output.metricDefinitions = priorDefinitions;
      output.omittedItems = catalog.items.length - index;
      output.itemsTruncated = true;
      break;
    }
  }
  return output;
}
const size = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
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
  text = scrubText(text, secrets, state, structured ? 'preview' : 'text');
  if (!structured) {
    const excerpt = textPrefix(text, Math.max(0, budget - 180));
    return {
      text: excerpt,
      source: { segment: 'prefix', inputCharacters: text.length },
      truncated: excerpt.length < text.length,
      redacted: state.redacted,
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
    const content = evidenceRecordContent(raw);
    const sanitized =
      typeof content === 'string' ? content : scrub(content, secrets, state);
    const text =
      typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
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
  if (![...runtimeEvolutionEvidenceViews, 'delivery'].includes(view))
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
    if (view === 'training' || view === 'training-summary') {
      const training = await projectMeasurementTrainingFeedback(
        measurement,
        artifacts,
        Math.max(
          0,
          Math.floor(
            options.includeExecutionPreviews === false ? quota : quota * 0.65,
          ) - size(result),
        ),
        secrets,
      );
      Object.assign(result, training);
      if (training.itemsTruncated || training.metricsOmitted)
        result.truncated = true;
    }
    const catalog =
      options.includeExecutionPreviews === false
        ? { entries: [] }
        : object(
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
