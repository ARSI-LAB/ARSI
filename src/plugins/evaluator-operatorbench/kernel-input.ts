import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseKernelContract, type KernelContract } from 'ember-evaluator';
import type { JsonObject } from '../../contracts/index.js';
import type { OperatorbenchInput } from '../../contracts/plugin-types/operatorbench.js';
import type { KernelExecution } from '../application-kernel/schema.js';
import { object } from '../../shared/json.js';

export type PreparedOperatorCase = {
  operation: OperatorbenchInput['action'];
  taskId: string;
  seed: number;
  contract: KernelContract;
  candidateSha256: string;
  referenceSha256: string;
  sourceInventory?: {
    entryFile: string;
    files: { path: string; sha256: string }[];
    mutablePaths: string[];
    /** Single-file SDK compatibility alias for the declared entryFile. */
    sdkEntryPath?: 'data/input.py';
  };
};

export async function prepareOperatorCase({
  task,
  selected,
  execution,
  manifest,
  operation,
  editablePaths,
}: {
  task: { definition: JsonObject; reference: Uint8Array };
  selected: { id: string; seed: number };
  execution: KernelExecution;
  manifest: string;
  operation: OperatorbenchInput['action'];
  editablePaths?: string[];
}): Promise<PreparedOperatorCase> {
  const data = dirname(manifest);
  const raw = object(task.definition.contract);
  const contract = parseKernelContract({
    ...raw,
    schemaVersion: 1,
    caseId: selected.id,
    inputs: Array.isArray(raw.inputs)
      ? raw.inputs.map((value) => ({
          ...object(value),
          contiguous: object(value).contiguous ?? true,
        }))
      : raw.inputs,
  });
  const bundled = execution.sourceFiles.length > 1;
  const root = await realpath(execution.directory);
  const candidate = bundled ? `candidate/${execution.sourcePath}` : 'input.py';
  await mkdir(data, { recursive: true });
  for (const file of execution.sourceFiles) {
    const sourceFile = join(root, file.path);
    if ((await realpath(sourceFile)) !== sourceFile)
      throw new Error(
        `Operator sourcePath contains a symbolic link: ${file.path}`,
      );
    const source = await readFile(sourceFile);
    if (createHash('sha256').update(source).digest('hex') !== file.sha256)
      throw new Error(`Operator source digest mismatch: ${file.path}`);
    const staged = join(data, bundled ? `candidate/${file.path}` : 'input.py');
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, source);
  }
  await writeFile(join(data, 'problem.py'), task.reference);
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: selected.id,
          problem: 'problem.py',
          candidate,
          ...(bundled
            ? {
                candidateRoot: 'candidate',
                files: execution.sourceFiles
                  .filter((file) => file.path !== execution.sourcePath)
                  .map((file) => `candidate/${file.path}`)
                  .sort(),
              }
            : {}),
          referenceKind: 'pytorch',
          contract,
        },
      ],
    }),
  );
  return {
    operation,
    taskId: selected.id,
    seed: selected.seed,
    contract,
    candidateSha256: execution.sourceDigest,
    referenceSha256: createHash('sha256').update(task.reference).digest('hex'),
    ...(bundled || editablePaths !== undefined
      ? {
          sourceInventory: {
            entryFile: execution.sourcePath,
            files: execution.sourceFiles,
            mutablePaths: editablePaths ?? [],
            ...(bundled ? {} : { sdkEntryPath: 'data/input.py' as const }),
          },
        }
      : {}),
  };
}
