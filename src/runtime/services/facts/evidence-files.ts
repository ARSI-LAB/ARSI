import {
  evidenceRecordContent,
  fullEvidenceText,
} from '../../../shared/evidence-redaction.js';
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { secretValues } from '../../../shared/secrets.js';
import {
  projectMeasurementTrainingFeedback,
  type EvidenceView,
} from './evidence.js';

/** Returns complete sanitized files and, for training, the authorized Measurement feedback. */
export async function projectEvidenceFiles(options: {
  measurements: JsonObject[];
  artifacts: ArtifactStore;
  view: EvidenceView;
  maxBytes?: number;
  directory?: string;
}): Promise<JsonObject> {
  if (options.view !== 'execution' && options.view !== 'training')
    throw new Error('File evidence requires the execution or training view');
  const files: JsonObject = {};
  const measurements: JsonObject[] = [];
  const result: JsonObject = {
    schemaVersion: 'rsi.evidence-files/v1',
    view: options.view,
    measurements,
    files,
  };
  const maxBytes = options.maxBytes;
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
  )
    throw new Error('Evidence budget must be a positive safe integer');
  let bytes = 0;
  const store = (path: string, content: string): void => {
    if (maxBytes !== undefined) {
      bytes += Buffer.byteLength(content);
      if (bytes > maxBytes)
        throw new Error(
          'Full execution evidence exceeds virtual-file byte limit',
        );
    }
    files[path] = content;
  };
  for (let mi = 0; mi < options.measurements.length; mi++) {
    const m = options.measurements[mi];
    if (
      m.schemaVersion !== 'rsi.measurement/v1' ||
      typeof m.ref !== 'string' ||
      m.ref.startsWith('artifact:')
    )
      throw new Error('File evidence requires authorized Measurement records');
    const catalog = object(
      await options.artifacts.readJson(string(m.evidenceIndexRef)),
    );
    if (!Array.isArray(catalog.entries))
      throw new Error('Invalid Measurement evidence index');
    const entries: JsonObject[] = [];
    measurements.push({
      measurementRef: m.ref,
      status: m.status ?? 'unknown',
      coverage: m.coverage ?? 'unknown',
      entries,
    });
    for (let ei = 0; ei < catalog.entries.length; ei++) {
      const e = object(catalog.entries[ei]);
      if (
        !['execution', 'delivery'].includes(String(e.access)) ||
        !['trajectory', 'final-text', 'delivery'].includes(String(e.kind))
      )
        continue;
      const entryFiles: JsonObject[] = [];
      const entry: JsonObject = {
        kind: e.kind,
        itemId: e.itemId ?? null,
        attemptId: e.attemptId ?? null,
        integrity: e.integrity ?? 'unknown',
        artifactRef: e.artifactRef ?? null,
        files: entryFiles,
      };
      entries.push(entry);
      if (
        typeof e.artifactRef !== 'string' ||
        ['missing', 'not-produced'].includes(String(e.integrity))
      ) {
        entry.inspection = 'unavailable';
        continue;
      }
      let raw: JsonValue;
      try {
        raw = await options.artifacts.readJson(e.artifactRef);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          entry.inspection = 'unavailable';
          continue;
        }
        throw error;
      }
      const source =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : null;
      const tree =
        source?.kind === 'file-tree' ? parseFileTree(source).files : null;
      if (!tree) {
        const record = evidenceRecordContent(raw);
        const content =
          typeof record === 'string' ? record : JSON.stringify(record);
        const format =
          typeof record !== 'string'
            ? 'json'
            : e.kind === 'trajectory'
              ? 'jsonl'
              : 'text';
        const safe = fullEvidenceText(content, format);
        const path = `${options.directory ?? 'context/evidence'}/${mi}/${ei}/record.txt`;
        store(path, safe.text);
        entryFiles.push({
          path,
          source: { artifactRef: e.artifactRef, pointer: '' },
          inspection: 'text',
          redacted: safe.redacted,
          truncated: safe.truncated,
        });
        continue;
      }
      for (let fi = 0; fi < tree.length; fi++) {
        const f = tree[fi]!;
        const originalPath = f.path;
        const content = Buffer.from(f.base64, 'base64');
        const sourceRef = {
          artifactRef: e.artifactRef,
          pointer: `/files/${fi}`,
          path: originalPath,
        };
        let decoded: string | null = null;
        if (!content.includes(0)) {
          try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
          } catch {
            /* Binary evidence remains addressable by provenance, not fabricated text. */
          }
        }
        if (decoded === null) {
          entryFiles.push({
            source: sourceRef,
            inspection: 'uninspected',
            sizeBytes: content.length,
          });
          continue;
        }
        const format = /\.(jsonl|ndjson)$/i.test(originalPath)
          ? 'jsonl'
          : /\.json$/i.test(originalPath)
            ? 'json'
            : 'text';
        const safe = fullEvidenceText(decoded, format);
        const path = `${options.directory ?? 'context/evidence'}/${mi}/${ei}/${fi}.txt`;
        store(path, safe.text);
        entryFiles.push({
          path,
          source: sourceRef,
          inspection: 'text',
          sizeBytes: content.length,
          redacted: safe.redacted,
          truncated: safe.truncated,
        });
      }
    }
  }
  // File mode guarantees complete execution files. Share the remaining serialized bytes across
  // measurements so that broad feedback from one does not crowd out every subsequent item.
  if (options.view === 'training') {
    let remaining =
      maxBytes === undefined
        ? Infinity
        : maxBytes - Buffer.byteLength(JSON.stringify(result));
    const secrets = secretValues();
    for (const [i, projected] of measurements.entries()) {
      // The feedback's two braces become a single comma when its fields are merged.
      const budget = Math.floor(remaining / (measurements.length - i)) + 1;
      const feedback = await projectMeasurementTrainingFeedback(
        options.measurements[i],
        options.artifacts,
        budget,
        secrets,
      );
      Object.assign(projected, feedback);
      if (maxBytes !== undefined)
        remaining -= Buffer.byteLength(JSON.stringify(feedback)) - 1;
    }
  }
  if (
    maxBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(result)) > maxBytes
  )
    throw new Error(
      'Full execution evidence index exceeds virtual-file size limit',
    );
  return result;
}
