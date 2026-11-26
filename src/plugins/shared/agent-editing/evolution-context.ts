import type { JsonObject, RuntimeContext } from '../../../contracts/index.js';
import {
  runtimeEvolutionEvidenceViews,
  type RuntimeEvolutionEvidenceView,
} from '../../../contracts/runtime-evolution.js';
import { canonical, object } from '../../../shared/json.js';
import { prepareDocumentPreviews } from '../../reflection-agent/document-previews.js';
import type { ReadOnlyEditContext } from './index.js';

export async function evolutionContext(
  kind: 'memory' | 'reflection',
  evidenceRefs: string[],
  context: RuntimeContext,
): Promise<ReadOnlyEditContext> {
  const indexPath = 'context/evolution/index.json';
  const files: Record<string, string> = {};
  const indexes: JsonObject[] = [];
  const sources: JsonObject[] = [];
  const limit = context.scope?.limits.evidenceBytes ?? Infinity;
  let evidenceView: RuntimeEvolutionEvidenceView | null = null;
  let bytes = 0;
  for (const ref of evidenceRefs) {
    const snapshot = await context.facts.read('evidence-views', ref);
    const view = runtimeEvolutionEvidenceViews.find(
      (v) => v === snapshot.evidenceView,
    );
    if (
      snapshot.experimentId !== context.experimentId ||
      snapshot.view !== 'evolution-observations/v1' ||
      snapshot.moduleKind !== kind ||
      view === undefined ||
      (evidenceView !== null && view !== evidenceView)
    )
      throw new Error(`${kind} evidence snapshot ownership or format mismatch`);
    evidenceView = view;
    for (const [path, content] of Object.entries(object(snapshot.files))) {
      if (!path.startsWith('context/evolution/') || typeof content !== 'string')
        throw new Error('Invalid runtime evolution evidence file');
      if (Object.hasOwn(files, path))
        throw new Error('Duplicate runtime evolution evidence file');
      if (path === indexPath) {
        // Only the persisted, byte-bounded index is authorized for this project.
        try {
          indexes.push({ ref, ...object(JSON.parse(content)) });
        } catch {
          indexes.push({ ref, truncated: true });
        }
        continue;
      }
      bytes += Buffer.byteLength(content);
      if (bytes > limit)
        throw new Error(
          'Runtime evolution evidence files exceed evidenceBytes',
        );
      files[path] = content;
    }
    if (Array.isArray(snapshot.sources))
      for (const source of snapshot.sources) sources.push(object(source));
  }
  const index = canonical({ indexes, previews: [] });
  const omitted = canonical({ truncated: true });
  files[indexPath] =
    bytes + Buffer.byteLength(index) <= limit
      ? index
      : bytes + Buffer.byteLength(omitted) <= limit
        ? omitted
        : '';
  const previews = await prepareDocumentPreviews({
    sources,
    files,
    artifacts: context.artifacts,
    signal: context.signal,
    maxBytes: context.scope?.limits.evidenceBytes,
  });
  if (previews.length) {
    const available =
      limit -
      Object.entries(files).reduce(
        (sum, [path, content]) =>
          path === indexPath ? sum : sum + Buffer.byteLength(content),
        0,
      );
    const full = canonical({ indexes, previews });
    if (Buffer.byteLength(full) <= available) files[indexPath] = full;
    else if (Buffer.byteLength(omitted) <= available)
      files[indexPath] = omitted;
  }
  return {
    files,
    evidence: { indexPath, views: evidenceRefs.length },
    input: { evidenceIndex: indexPath, evidenceView },
  };
}
