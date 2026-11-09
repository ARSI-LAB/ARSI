import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseKernelContract, type KernelContract } from 'ember-evaluator';
import type { OperatorbenchInput } from '../../contracts/plugin-types/operatorbench.js';
import type { KernelExecution } from '../application-kernel/schema.js';
import { object } from '../../shared/json.js';

export type PreparedOperatorCase = {
  operation: OperatorbenchInput['action'];
  taskId: string;
  seed: number;
  contract: KernelContract;
  candidateSha256: string;
};

export async function prepareOperatorCase({
  taskDirectory,
  rawContract,
  selected,
  execution,
  manifest,
  operation,
}: {
  taskDirectory: string;
  rawContract: unknown;
  selected: { id: string; seed: number };
  execution: KernelExecution;
  manifest: string;
  operation: OperatorbenchInput['action'];
}): Promise<PreparedOperatorCase> {
  const data = dirname(manifest);
  const raw = object(rawContract);
  const contract = parseKernelContract({
    ...raw,
    schemaVersion: 1,
    caseId: selected.id,
    inputs: Array.isArray(raw.inputs)
      ? raw.inputs.map((value) => ({ ...object(value), contiguous: true }))
      : raw.inputs,
  });
  const source = await readFile(join(execution.directory, 'input.py'));
  if (
    createHash('sha256').update(source).digest('hex') !== execution.sourceDigest
  )
    throw new Error('Operator source digest mismatch');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'input.py'), source);
  const reference = await readFile(join(taskDirectory, 'problem.py'));
  await writeFile(join(data, 'problem.py'), reference);
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: selected.id,
          problem: 'problem.py',
          candidate: 'input.py',
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
  };
}
