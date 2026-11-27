import type { JsonObject, JsonValue } from '../contracts/index.js';
import { redactText, secretValues } from './secrets.js';

export interface ScrubState {
  redacted: boolean;
  truncated: boolean;
}
const forbidden = (key: string): boolean =>
  ['__proto__', 'constructor', 'prototype'].includes(key) ||
  /^(evaluation|evaluationFeedback|feedback|metricDefinitions|trainingSummary|returnedHints?|datasetHints?)$/i.test(
    key,
  ) ||
  /score|reward|passed|successrate|correctness|verdict|grader|grading|judge|groundtruth|expectedanswer|expectedoutput|referenceanswer|private|secret|password|apikey|authorization|credential|metrics|candidateref|candidateid|measurementref|attemptid|itemid/.test(
    key.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
/** A tool result may contain a serialized projection, including inside another trace event. */
export function scrubText(
  text: string,
  secrets: string[],
  state: ScrubState,
  format: 'json' | 'jsonl' | 'text' | 'preview' = 'text',
): string {
  const safe = redactText(text, secrets);
  if (safe !== text) state.redacted = true;
  if (format === 'json' || /^\s*[\[{]/.test(safe)) {
    let parsed: JsonValue | undefined;
    try {
      parsed = JSON.parse(safe);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (parsed !== undefined) {
      const nested: ScrubState = { redacted: false, truncated: false };
      const value = scrub(parsed, secrets, nested);
      if (nested.redacted || format === 'json') {
        state.redacted ||= nested.redacted;
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
      return safe;
    }
  }
  if (format !== 'preview' && safe.includes('\n') && /^[ \t]*[\[{]/m.test(safe))
    return safe
      .split('\n')
      .map((line) => scrubText(line, secrets, state))
      .join('\n');
  return safe;
}
function isTrainingProjection(value: JsonObject): boolean {
  return (
    value.view === 'training' ||
    value.view === 'training-summary' ||
    value.schemaVersion === 'rsi.evaluation-feedback/v1'
  );
}

/** Native evidence may wrap its content in a text field. Preserve scoring envelopes for redaction. */
export function evidenceRecordContent(record: JsonValue): JsonValue {
  return record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof record.text === 'string' &&
    !isTrainingProjection(record)
    ? record.text
    : record;
}
export function scrub(
  value: JsonValue,
  secrets: string[],
  state: ScrubState,
): JsonValue {
  if (typeof value === 'string') return scrubText(value, secrets, state);
  if (Array.isArray(value))
    return value.map((item) => scrub(item, secrets, state));
  if (value !== null && typeof value === 'object') {
    if (isTrainingProjection(value)) {
      state.redacted = true;
      return '[training feedback omitted]';
    }
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
/** Wrapper summaries are execution context. Only validated Measurements supply training feedback. */
export function executionEvidenceValue(value: JsonValue): JsonValue {
  return scrub(value, secretValues(), { redacted: false, truncated: false });
}
/** Full text projection retains all lines while applying the execution-view redaction rules. */
export function fullEvidenceText(
  text: string,
  format: 'text' | 'json' | 'jsonl',
): { text: string; redacted: boolean; truncated: boolean } {
  const state: ScrubState = { redacted: false, truncated: false };
  return { text: scrubText(text, secretValues(), state, format), ...state };
}
