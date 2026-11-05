import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, matchesGlob } from 'node:path';
import type {
  ApplicationOutput,
  RuntimeContext,
  JsonObject,
  JsonSchema,
  JsonValue,
  Workspace,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { applicationContract } from '../../../contracts/plugin-types/application.js';
import { inside } from '../../../runtime/storage/index.js';
import { object, string, strings } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';
import type { AgentEditingConfig } from './schema.js';
export { agentConfigSchema, type AgentEditingConfig } from './schema.js';
export const editOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: ['string', 'null'] },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
  },
  required: ['edits', 'reason'],
  additionalProperties: false,
};
export interface ReadOnlyEditContext {
  files: JsonObject;
  evidence: JsonValue;
  input: JsonObject;
}
/** Include source executions when an editor composes other proposals. */
export function editEvidenceRefs(input: JsonObject): string[] {
  return [
    ...new Set([
      ...strings(input.evidenceRefs ?? []),
      ...(Array.isArray(input.sources)
        ? input.sources
            .map((v) => object(v).measurementRef)
            .filter((v): v is string => typeof v === 'string')
        : []),
    ]),
  ];
}
/** Reload plugin-owned guidance for each request without changing the base prompt. */
export async function loadAgentPrompt(
  config: AgentEditingConfig,
): Promise<string> {
  const prompt = await readFile(config.prompt, 'utf8');
  if (config.guidance === undefined) return prompt;
  const directory = config.guidance;
  const files: string[] = [];
  async function collect(path: string, relative: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`Agent guidance cannot follow a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of await readdir(path))
        await collect(
          join(path, name),
          relative ? `${relative}/${name}` : name,
        );
    } else if (stat.isFile()) {
      if (relative.toLowerCase().endsWith('.md')) files.push(relative);
    } else throw new Error(`Agent guidance requires ordinary files: ${path}`);
  }
  const root = await lstat(directory);
  if (root.isSymbolicLink())
    throw new Error(
      `Agent guidance cannot follow a symbolic link: ${directory}`,
    );
  if (!root.isDirectory())
    throw new Error(`Agent guidance must be a directory: ${directory}`);
  await collect(directory, '');
  const guidance: string[] = [];
  for (const file of files.sort()) {
    const content = await readFile(join(directory, file), 'utf8');
    if (content.trim()) guidance.push(`### ${file}\n\n${content}`);
  }
  return guidance.length
    ? `${prompt}\n\n## Guidance\n\n${guidance.join('\n\n')}`
    : prompt;
}
export async function resourceFiles(
  ref: string | null,
  services: RuntimeContext,
): Promise<JsonObject> {
  if (ref === null) return {};
  const tree = parseFileTree(await services.artifacts.readJson(ref));
  const files: JsonObject = {};
  let size = 0;
  for (const f of tree.files) {
    const content = Buffer.from(f.base64, 'base64');
    if (content.includes(0)) continue;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      continue;
    }
    size += content.length;
    if (size > 2 * 1024 * 1024)
      throw new Error('Editable text snapshot exceeds size limit');
    files[string(f.path)] = decoded;
  }
  return files;
}
export async function requestEdit(
  config: AgentEditingConfig,
  input: JsonObject,
  ref: string | null,
  context: RuntimeContext,
  readOnly?: ReadOnlyEditContext,
): Promise<JsonObject> {
  const files = await resourceFiles(ref, context);
  if (readOnly)
    for (const [path, content] of Object.entries(readOnly.files)) {
      if (Object.hasOwn(files, path))
        throw new Error('Read-only context shadows an editable file');
      files[path] = content;
    }
  const evidence =
    readOnly?.evidence ??
    (await context.readEvidence(editEvidenceRefs(input), {
      view: config.evidenceView ?? 'execution',
    }));
  const skills = await Promise.all(
    (config.skills ?? []).map(async (path) => ({
      path,
      content: await readFile(
        (await lstat(path)).isDirectory() ? join(path, 'SKILL.md') : path,
        'utf8',
      ),
    })),
  );
  const memory = input.memoryRef
    ? await resourceFiles(string(input.memoryRef), context)
    : null;
  const sources: JsonObject[] = [];
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources))
      throw new Error('sources must be an array');
    if (
      input.sources.length > 0 &&
      Object.keys(files).some(
        (path) => path === 'sources' || path.startsWith('sources/'),
      )
    )
      throw new Error('Read-only source context shadows an editable file');
    for (let i = 0; i < input.sources.length; i++) {
      const source = object(input.sources[i]);
      const candidate = await context.readCandidate(
        string(source.candidateRef),
      );
      const contents = await resourceFiles(candidate.artifactRef, context);
      const names = Object.keys(contents).sort();
      for (const name of names) files[`sources/${i}/${name}`] = contents[name];
      sources.push({
        candidateRef: candidate.ref,
        files: names.map((name) => `sources/${i}/${name}`),
        measurementRef: source.measurementRef ?? null,
      });
    }
  }
  const request: JsonObject = {
    goal: string(input.goal),
    prompt: await loadAgentPrompt(config),
    files,
    input: {
      evidence,
      target: input.target ?? null,
      memory,
      sources,
      skills,
      editConstraints: input.editConstraints ?? {},
      observations: input.observations ?? null,
      ...readOnly?.input,
    },
    outputSchema: object(editOutputSchema),
    agentRef: config.agentRef ?? 'agent.default',
    maxModelCalls: config.maxModelCalls ?? 24,
  };
  const result = await context.invokeAgent(request);
  validate(editOutputSchema, result, 'Agent edit output');
  if (Array.isArray(result.edits))
    for (const raw of result.edits) {
      const path = string(object(raw).path);
      if (readOnly && (path === 'context' || path.startsWith('context/')))
        throw new Error('Cannot modify read-only comparison context');
      if (
        sources.length > 0 &&
        (path === 'sources' || path.startsWith('sources/'))
      )
        throw new Error('Cannot modify read-only source context');
    }
  return result;
}
/** Validate the complete plan before any file is changed. */
export async function validateEdits(
  directory: string,
  result: JsonObject,
  context: RuntimeContext,
  constraints: JsonObject = {},
  allowDuplicatePaths = false,
): Promise<{ path: string; content: string | null }[]> {
  if (!Array.isArray(result.edits) || result.edits.length > 32)
    throw new Error('Expected bounded edits array');
  const allowed =
    constraints.allowedPaths === undefined
      ? null
      : strings(constraints.allowedPaths);
  const maxFiles = Math.min(
    32,
    typeof constraints.maxChangedFiles === 'number'
      ? constraints.maxChangedFiles
      : 32,
  );
  const maxBytes = Math.min(
    1048576,
    !allowDuplicatePaths && typeof constraints.maxChangedBytes === 'number'
      ? constraints.maxChangedBytes
      : 1048576,
  );
  const seen = new Set<string>();
  const removed = new Set<string>();
  const edits: { path: string; content: string | null }[] = [];
  let total = 0;
  for (const raw of result.edits) {
    context.signal.throwIfAborted();
    const edit = object(raw);
    const path = string(edit.path);
    if (
      (!allowDuplicatePaths && seen.has(path)) ||
      path.includes('\\') ||
      path.split('/').some((x) => !x || x === '.' || x === '..')
    )
      throw new Error('Invalid or duplicate edit path');
    if (allowed && !allowed.some((pattern) => matchesGlob(path, pattern)))
      throw new Error(`Resource edit path is not authorized: ${path}`);
    seen.add(path);
    if (seen.size > maxFiles)
      throw new Error('Resource edit maxChangedFiles exceeded');
    const absolute = inside(directory, path);
    let node = directory;
    for (const part of path.split('/')) {
      node = join(node, part);
      // Earlier deletions make this path absent when the plan is applied.
      // In particular, POSIX lstat would otherwise reject a/b with ENOTDIR
      // while a is still the file scheduled for deletion.
      if (removed.has(node)) break;
      try {
        const stat = await lstat(node);
        if (stat.isSymbolicLink())
          throw new Error('Resource edit cannot follow a symbolic link');
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    if (edit.content !== null) {
      if (typeof edit.content !== 'string')
        throw new Error('Invalid edit content');
      const length = Buffer.byteLength(edit.content);
      total += length;
      if (length > 131072 || total > maxBytes)
        throw new Error('Resource edit exceeds byte limit');
    }
    if (edit.content === null) removed.add(absolute);
    else removed.delete(absolute);
    edits.push({ path, content: edit.content });
  }
  return edits;
}
export async function applyEdits(
  directory: string,
  result: JsonObject,
  context: RuntimeContext,
  constraints: JsonObject = {},
): Promise<void> {
  const edits = await validateEdits(directory, result, context, constraints);
  for (const edit of edits) {
    context.signal.throwIfAborted();
    const absolute = inside(directory, edit.path);
    if (edit.content === null) await rm(absolute, { force: true });
    else {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, edit.content, { mode: 0o644 });
    }
  }
}
/** The caller owns workspace release, including failed commits. */
export async function commitEdits(
  workspace: Workspace,
  result: JsonObject,
  parentRef: string,
  context: RuntimeContext,
  constraints?: JsonObject,
): Promise<Extract<ApplicationOutput, { action: 'commit' }>> {
  await applyEdits(workspace.directory, result, context, constraints);
  const committed = await context.application({
    action: 'commit',
    parentCandidateRef: parentRef,
    editRef: workspace.ref,
    ...(constraints ? { editConstraints: constraints } : {}),
  });
  validate(
    applicationContract.output_schema,
    committed,
    'Application commit output',
  );
  if (committed.action !== 'commit')
    throw new Error('Application did not return a commit result');
  const status = committed.status;
  if (status !== 'created' && status !== 'no-change')
    throw new Error('Invalid Application commit status');
  return {
    action: 'commit',
    status,
    candidateRef: string(committed.candidateRef),
    diffRef: committed.diffRef === null ? null : string(committed.diffRef),
  };
}
export async function editResource(
  config: AgentEditingConfig,
  input: JsonObject,
  ref: string | null,
  context: RuntimeContext,
  readOnly?: ReadOnlyEditContext,
): Promise<{
  resourceRef: string | null;
  changeRef: string | null;
  reason: string;
}> {
  const result = await requestEdit(config, input, ref, context, readOnly);
  const workspace = await context.workspaces.create(ref ?? undefined);
  try {
    await applyEdits(
      workspace.directory,
      result,
      context,
      input.editConstraints === undefined ? {} : object(input.editConstraints),
    );
    const updated = await context.artifacts.capture(workspace.directory);
    const old =
      ref ??
      (await context.artifacts.putJson({ kind: 'file-tree', files: [] }));
    if (updated === old)
      return {
        resourceRef: ref,
        changeRef: null,
        reason: string(result.reason),
      };
    const changeRef = await context.artifacts.putJson({
      before: ref,
      after: updated,
      edits: result.edits,
    });
    return { resourceRef: updated, changeRef, reason: string(result.reason) };
  } finally {
    await context.workspaces.release(workspace.ref);
  }
}
export function operationSchema(
  properties: JsonObject,
  required: string[],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
export const refSchema: JsonObject = { type: 'string', minLength: 1 };
