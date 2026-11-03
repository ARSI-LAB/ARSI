import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { fullEvidenceText, type EvidenceView } from './evidence.js';

/** Receives already-authorized Measurements. File mode deliberately excludes scoring views. */
export async function projectEvidenceFiles(options: {
  measurements: JsonObject[];
  artifacts: ArtifactStore;
  view: EvidenceView;
  maxBytes: number;
}): Promise<JsonObject> {
  if (options.view !== 'execution')
    throw new Error('File evidence requires the execution view');
  const files: JsonObject = {};
  const measurements: JsonObject[] = [];
  const result: JsonObject = {
    schemaVersion: 'rsi.evidence-files/v1',
    view: 'execution',
    measurements,
    files,
  };
  let bytes = 0;
  const store = (path: string, content: string): void => {
    bytes += Buffer.byteLength(content);
    if (bytes > options.maxBytes)
      throw new Error(
        'Full execution evidence exceeds virtual-file byte limit',
      );
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
        const content =
          typeof source?.text === 'string'
            ? source.text
            : typeof raw === 'string'
              ? raw
              : JSON.stringify(raw);
        const format =
          typeof source?.text === 'string' || typeof raw === 'string'
            ? 'text'
            : 'json';
        const safe = fullEvidenceText(content, format);
        const path = `context/evidence/${mi}/${ei}/record.txt`;
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
        const path = `context/evidence/${mi}/${ei}/${fi}.txt`;
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
  if (Buffer.byteLength(JSON.stringify(result)) > options.maxBytes)
    throw new Error(
      'Full execution evidence index exceeds virtual-file size limit',
    );
  return result;
}
