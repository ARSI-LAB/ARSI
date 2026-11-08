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

export const proposerEditOutputSchema: JsonSchema = {
  ...editOutputSchema,
  properties: {
    reason: { type: 'string' },
    edits: {
      type: 'array',
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
                    oldText: { type: 'string' },
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

/** Resolve the edit operations against the immutable parent. */
export function expandEdits(
  result: JsonObject,
  artifact: JsonValue,
): {
  result: JsonObject;
  createOnly: ReadonlySet<string>;
  hasDuplicates: boolean;
} {
  const parent = new Map(
    parseFileTree(artifact).files.map((file) => [file.path, file]),
  );
  const seen = new Map<string, string>();
  const createOnly = new Set<string>();
  let hasDuplicates = false;
  const edits = (result.edits as JsonObject[]).map((edit) => {
    const path = safePath(edit.path);
    if (process.platform === 'win32' && /[:*?"<>|]|[. ](?:\/|$)/.test(path))
      throw new Error(`Invalid Windows edit path: ${path}`);
    const op = string(edit.op);
    const previous = seen.get(path);
    if (previous !== undefined) {
      // Repeated creates or deletes are reconciled after scope validation.
      if (op === 'patch' || previous === 'patch')
        throw new Error(`Duplicate edit path: ${path}`);
      hasDuplicates = true;
    }
    seen.set(path, op);
    const file = parent.get(path);
    if (op === 'create') {
      if (file) throw new Error(`Cannot create ${path}: path already exists`);
      createOnly.add(path);
      return { path, content: edit.content };
    }
    if (!file) throw new Error(`Cannot ${op} ${path}: file does not exist`);
    if (op === 'delete') return { path, content: null };

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
    const changes = edit.changes as JsonObject[];
    const spans = changes
      .map((raw, index) => {
        const change = object(raw);
        const oldText = change.oldText as string;
        const label = `Patch ${path}, change ${index + 1}`;
        if (oldText === '' && (original !== '' || changes.length !== 1))
          throw new Error(
            `${label}: empty oldText requires one change to an empty file`,
          );
        const start = original.indexOf(oldText);
        if (start < 0) throw new Error(`${label}: oldText not found`);
        if (oldText !== '' && original.indexOf(oldText, start + 1) >= 0)
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
  return {
    result: { edits, reason: result.reason },
    createOnly,
    hasDuplicates,
  };
}

/** Collapse identical creates or deletes and retain the parent on conflicting additions. */
export function collapseDuplicateEdits(result: JsonObject): JsonObject {
  const edits = new Map<string, JsonObject>();
  const conflicts = new Set<string>();
  for (const edit of result.edits as JsonObject[]) {
    const path = string(edit.path);
    const previous = edits.get(path);
    if (!previous) edits.set(path, edit);
    else if (previous.content !== edit.content) conflicts.add(path);
  }
  if (conflicts.size)
    return {
      edits: [],
      reason: `Duplicate edit conflicts (different new-file additions): ${[...conflicts].join(', ')}. Retained the parent for the whole proposal. Original reason: ${result.reason}`,
    };
  return { edits: [...edits.values()], reason: result.reason };
}
