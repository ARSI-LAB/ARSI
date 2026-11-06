import {
  parseFileTree,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { editOutputSchema } from '../shared/agent-editing/index.js';
import { safePath } from '../shared/file-application/target.js';

const path = { type: 'string', minLength: 1 };

export const patchEditOutputSchema: JsonSchema = {
  ...editOutputSchema,
  properties: {
    reason: { type: 'string' },
    edits: {
      type: 'array',
      maxItems: 32,
      items: {
        // Required, distinct op tags keep these branches exclusive with anyOf.
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['op', 'path', 'changes'],
            properties: {
              op: { const: 'patch' },
              path,
              changes: {
                type: 'array',
                minItems: 1,
                maxItems: 32,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['oldText', 'newText'],
                  properties: {
                    oldText: { type: 'string', minLength: 1 },
                    newText: { type: 'string' },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['op', 'path', 'content'],
            properties: {
              op: { const: 'create' },
              path,
              content: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['op', 'path'],
            properties: { op: { const: 'delete' }, path },
          },
        ],
      },
    },
  },
};

/** Expand a schema-validated batch against the immutable parent. */
export function expandPatchEdits(
  result: JsonObject,
  artifact: JsonValue,
): JsonObject {
  const parent = new Map(
    parseFileTree(artifact).files.map((file) => [file.path, file]),
  );
  const seen = new Set<string>();
  const edits = (result.edits as JsonObject[]).map((edit) => {
    const path = safePath(edit.path);
    if (process.platform === 'win32' && /[:*?"<>|]|[. ](?:\/|$)/.test(path))
      throw new Error(`Invalid Windows edit path: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate edit path: ${path}`);
    seen.add(path);
    const file = parent.get(path);
    if (edit.op === 'create') {
      if (file) throw new Error(`Cannot create ${path}: path already exists`);
      return { path, content: edit.content };
    }
    if (!file)
      throw new Error(`Cannot ${edit.op} ${path}: file does not exist`);
    if (edit.op === 'delete') return { path, content: null };

    const bytes = Buffer.from(file.base64, 'base64');
    let original: string;
    try {
      if (bytes.includes(0)) throw new Error('Binary file');
      original = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new Error(`Cannot patch ${path}: expected a UTF-8 text file`);
    }
    const spans = (edit.changes as JsonObject[])
      .map((raw, index) => {
        const change = object(raw);
        const oldText = string(change.oldText);
        const start = original.indexOf(oldText);
        const label = `Patch ${path}, change ${index + 1}`;
        if (start < 0) throw new Error(`${label}: oldText not found`);
        if (original.indexOf(oldText, start + 1) >= 0)
          throw new Error(`${label}: ambiguous oldText; include more context`);
        return {
          start,
          end: start + oldText.length,
          replacement: change.newText as string,
        };
      })
      .sort((a, b) => a.start - b.start);

    let cursor = 0;
    let content = '';
    for (const span of spans) {
      if (span.start < cursor)
        throw new Error(`Patch ${path}: changes overlap`);
      content += original.slice(cursor, span.start) + span.replacement;
      cursor = span.end;
    }
    return { path, content: content + original.slice(cursor) };
  });
  return { edits, reason: result.reason };
}
