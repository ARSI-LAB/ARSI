import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseKernelContract, type KernelContract } from 'ember-evaluator';
import type { JsonObject } from '../../contracts/index.js';
import type { OperatorbenchInput } from '../../contracts/plugin-types/operatorbench.js';
import type { KernelExecution } from '../application-kernel/schema.js';
import { object, string } from '../../shared/json.js';

export type PreparedOperatorCase = {
  operation: OperatorbenchInput['action'];
  taskId: string;
  seed: number;
  contract: KernelContract;
  candidateSha256: string;
  referenceSha256: string;
  sourceInventory: {
    entryFile: string;
    files: { path: string; sha256: string }[];
    mutablePaths: string[];
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
  editablePaths: string[];
}): Promise<PreparedOperatorCase> {
  const data = dirname(manifest);
  const contract = parseKernelContract({
    ...object(task.definition.contract),
    caseId: selected.id,
  });
  const root = await realpath(execution.directory);
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
    const staged = join(data, 'candidate', file.path);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, source);
  }
  await writeFile(join(data, 'problem.py'), task.reference);
  await writeFile(
    manifest,
    JSON.stringify({
      tasks: [
        {
          id: selected.id,
          problem: 'problem.py',
          candidateRoot: 'candidate',
          candidate: `candidate/${execution.sourcePath}`,
          files: execution.sourceFiles
            .filter((file) => file.path !== execution.sourcePath)
            .map((file) => `candidate/${file.path}`)
            .sort(),
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
    candidateSha256: string(
      execution.sourceFiles.find((file) => file.path === execution.sourcePath)
        ?.sha256,
    ),
    referenceSha256: createHash('sha256').update(task.reference).digest('hex'),
    sourceInventory: {
      entryFile: execution.sourcePath,
      files: execution.sourceFiles,
      mutablePaths: editablePaths,
    },
  };
}
