import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseKernelContract, type KernelContract } from 'ember-evaluator';
import type { OperatorbenchConfig } from './schema.js';
import {
  parseEvaluatorConfig,
  type SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';
import { plain } from '../shared/evaluator-adapter/data.js';
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

type OperatorRunInput = {
  config: OperatorbenchConfig;
  rawContract: unknown;
  selected: { id: string; seed: number };
  execution: { directory: string; sourceDigest: string };
  directory: string;
  operation: PreparedSdkRun['operation'];
};

export async function prepareOperatorRun(
  input: OperatorRunInput,
): Promise<PreparedSdkRun> {
  const { config, rawContract, selected, execution, directory, operation } =
    input;
  const data = join(directory, 'sdk-input');
  const manifest = join(data, 'manifest.json');
  const evaluationConfig = prepareEvaluationConfig(input, manifest);
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
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'input.py'), source);
  const reference = await readFile(join(config.task.directory, 'problem.py'));
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
  const configPath = join(directory, 'sdk-config.json');
  await writeFile(configPath, JSON.stringify(evaluationConfig), {
    mode: 0o600,
  });
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

function prepareEvaluationConfig(
  {
    config: { task: _task, ...template },
    directory,
    selected,
    operation,
  }: OperatorRunInput,
  manifest: string,
): SdkEvaluatorConfig {
  const benchmark =
    typeof template.benchmark === 'string'
      ? { name: template.benchmark }
      : object(template.benchmark, 'benchmark');
  const kernel = plain(benchmark.config);
  const store =
    typeof template.store === 'string'
      ? { name: template.store }
      : plain(template.store);
  const storeConfig = plain(store.config);
  if (Object.hasOwn(template, 'services'))
    throw new Error('services is owned by RSI for kernel replay');
  if (benchmark.name !== 'kernel')
    throw new Error('operatorbench requires benchmark.name=kernel');
  if (template.deployment !== undefined)
    throw new Error('operatorbench requires local SDK execution');
  if (store.name !== undefined && store.name !== 'local')
    throw new Error('operatorbench requires a local run store');
  for (const field of ['manifest', 'operation', 'seeds']) {
    if (field in kernel)
      throw new Error(`benchmark.config.${field} is owned by RSI`);
  }
  if (storeConfig.runIndexDirectory !== undefined)
    throw new Error('store.config.runIndexDirectory is owned by RSI');
  if (plain(template.output).directory !== undefined)
    throw new Error('output.directory is owned by RSI');
  const { sampling: _sampling, offset: _offset, ...run } = plain(template.run);
  return parseEvaluatorConfig({
    ...template,
    // The SDK requires a service even though kernel-replay never calls a model.
    services: {
      default: {
        model: 'kernel-replay-no-model',
        base_url: 'http://127.0.0.1:1',
        api_key: '${RSI_KERNEL_REPLAY_NO_MODEL_KEY}',
      },
    },
    benchmark: {
      ...benchmark,
      config: {
        ...kernel,
        manifest,
        operation,
        seeds: [selected.seed],
        ...(operation === 'profile' && {
          profiling: {
            ...plain(kernel.profiling),
            enabled: true,
            cacheEnabled: false,
          },
        }),
      },
    },
    store: {
      ...store,
      config: {
        ...storeConfig,
        runIndexDirectory: join(directory, 'sdk-index'),
      },
    },
    run: { ...run, maxTasks: null, taskIds: [selected.id] },
    output: {
      ...plain(template.output),
      directory: join(directory, 'sdk-output'),
    },
  });
}
