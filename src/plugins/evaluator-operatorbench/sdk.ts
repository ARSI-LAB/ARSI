import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseKernelContract, type KernelContract } from 'ember-evaluator';
import type { SdkOperatorbenchConfig } from './schema.js';
import { object } from '../../shared/json.js';
export type PreparedSdkRun = {
  operation: 'evaluate' | 'profile';
  configPath: string;
  contract: KernelContract;
  taskId: string;
  candidateSha256: string;
  referenceSha256: string;
  env: Record<string, string>;
};

export async function prepareSdkConfiguration(
  config: SdkOperatorbenchConfig,
  rawContract: unknown,
  selected: { id: string; seed: number },
  execution: { directory: string; sourceDigest: string },
  directory: string,
  operation: 'evaluate' | 'profile' = 'evaluate',
): Promise<PreparedSdkRun> {
  const raw = object(rawContract);
  const contract = parseKernelContract({
    ...raw,
    schemaVersion: 1,
    caseId: selected.id,
    inputs: (raw.inputs as unknown[]).map((value) => ({
      ...object(value),
      contiguous: true,
    })),
  });
  const source = await readFile(join(execution.directory, 'input.py'));
  if (
    createHash('sha256').update(source).digest('hex') !== execution.sourceDigest
  )
    throw new Error('Operator source digest mismatch');
  const data = join(directory, 'sdk-input');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'input.py'), source);
  const reference = await readFile(join(config.task.directory, 'problem.py'));
  await writeFile(join(data, 'problem.py'), reference);
  await writeFile(
    join(data, 'manifest.json'),
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
  const configPath = join(directory, 'sdk-config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        services: {
          default: {
            model: 'kernel-replay-no-model',
            base_url: 'http://127.0.0.1:1',
            api_key: '${RSI_KERNEL_REPLAY_NO_MODEL_KEY}',
          },
        },
        benchmark: {
          name: 'kernel',
          config: {
            operation,
            manifest: join(data, 'manifest.json'),
            python: config.sdk.python,
            device: config.sdk.device,
            seeds: [selected.seed],
            rtol: config.protocol.rtol,
            atol: config.protocol.atol,
            warmup: config.protocol.warmup,
            repeat: config.protocol.repeat,
            timeoutSeconds: config.sdk.timeoutSeconds,
            profiling:
              operation === 'profile'
                ? {
                    ...config.sdk.profiling,
                    enabled: true,
                    cacheEnabled: false,
                  }
                : config.sdk.profiling,
          },
          solver: { name: 'kernel-replay' },
        },
        environment: 'local',
        scheduler: { name: 'local', config: { concurrency: 1 } },
        store: {
          name: 'local',
          config: { runIndexDirectory: join(directory, 'sdk-index') },
        },
        run: {
          taskIds: [selected.id],
          timeoutSeconds: config.sdk.timeoutSeconds + 30,
          onError: 'abort',
        },
        output: { directory: join(directory, 'sdk-output') },
      },
      null,
      2,
    ) + '\n',
  );
  return {
    operation,
    configPath,
    contract,
    taskId: selected.id,
    candidateSha256: execution.sourceDigest,
    referenceSha256: createHash('sha256').update(reference).digest('hex'),
    env: { RSI_KERNEL_REPLAY_NO_MODEL_KEY: 'not-a-secret-no-model-calls' },
  };
}
