import { fileURLToPath } from 'node:url';
import type { AgentEditingConfig } from './schema.js';
import type {
  OperationDefinition,
  ReflectionInput,
  ReflectionOutput,
} from '../../contracts/index.js';
import { json, object, string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { prepareDocumentPreviews } from './document-previews.js';

export const reflectionReviewer = {
  name: 'reflection-reviewer',
  description:
    'Review a focused Reflection question against the authorized workspace evidence.',
  prompt: fileURLToPath(new URL('./reviewer.md', import.meta.url)),
};

export const createReflectionAgent: OperationDefinition<
  ReflectionInput,
  ReflectionOutput,
  AgentEditingConfig
>['create'] = async (config, _context) => {
  return {
    async execute(input, context) {
      json(input);
      const files: Record<string, string> = {};
      const indexes = [];
      const sources = [];
      for (const ref of input.evidenceRefs) {
        const snapshot = await context.facts.read('evidence-views', ref);
        if (
          snapshot.experimentId !== context.experimentId ||
          snapshot.view !== 'reflection-observations/v1' ||
          snapshot.evidenceView !== (config.evidenceView ?? 'execution')
        )
          throw new Error(
            'Reflection evidence snapshot ownership or format mismatch',
          );
        for (const [path, content] of Object.entries(
          object(snapshot.files ?? {}),
        )) {
          if (!path.startsWith('context/') || typeof content !== 'string')
            throw new Error('Invalid Reflection read-only evidence file');
          if (Object.hasOwn(files, path))
            throw new Error('Duplicate Reflection evidence file');
          files[path] = content;
        }
        indexes.push({ ref, ...object(snapshot.index ?? {}) });
        if (Array.isArray(snapshot.sources))
          for (const source of snapshot.sources) sources.push(object(source));
      }
      const previews = await prepareDocumentPreviews({
        sources,
        files,
        artifacts: context.artifacts,
        signal: context.signal,
        maxBytes: context.scope?.limits.evidenceBytes,
      });
      const indexPath = 'context/reflection/index.json';
      files[indexPath] = JSON.stringify({ indexes, previews }, null, 2);
      const updated = await editResource(
        config,
        input,
        string(input.resourceRef),
        context,
        {
          files,
          evidence: { indexPath, views: indexes.length },
          input: {
            evidenceView: config.evidenceView ?? 'execution',
            evidenceIndex: indexPath,
            readOnlyPaths: Object.keys(files),
          },
        },
        [reflectionReviewer],
      );
      if (updated.changeRef !== null)
        return {
          status: 'proposed',
          proposal: {
            parentRevisionRefs: input.parentRevisionRefs,
            resourceRef: string(updated.resourceRef),
            changeRef: updated.changeRef,
          },
          reason: updated.reason,
        };
      return {
        status: 'no-change',
        proposal: null,
        reason: updated.reason,
      };
    },
    async dispose() {},
  };
};
