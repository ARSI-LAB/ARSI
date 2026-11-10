import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareOperatorCase } from '../../src/plugins/evaluator-operatorbench/kernel-input.js';
import { parseKernelExecution } from '../../src/plugins/application-kernel/schema.js';
import { loadOperatorTask } from '../../src/plugins/shared/operator-task.js';

const selected = { id: 'fixed', seed: 42 };
const fp16 = { shape: [2], dtype: 'float16' };
const output = { ...fp16, contiguous: true, independent: true };

async function taskFiles(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'operator-task-tensors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'problem.py'), '# reference\n');
  await writeFile(join(directory, 'test.py'), '# tests\n');
  async function load(inputs: unknown[], result: unknown = output) {
    const definition = {
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'tensor',
      cases: [selected],
      contract: { inputs, output: result, inputUnmodified: true },
    };
    await writeFile(join(directory, 'task.json'), JSON.stringify(definition));
    return loadOperatorTask(directory);
  }
  return { directory, load };
}

test('operator task loader accepts mixed floating dtypes and scalar shapes', async (t) => {
  const { load } = await taskFiles(t);
  const inputs = [
    { dtype: 'float32', shape: [] },
    { dtype: 'bfloat16', shape: [2], contiguous: false },
  ];
  const scalar = { ...output, dtype: 'bfloat16', shape: [] };
  assert.deepEqual((await load(inputs, scalar)).definition.contract, {
    inputs,
    output: scalar,
    inputUnmodified: true,
  });
  for (const invalid of [
    { dtype: 'int32' },
    { shape: [0] },
    { contiguous: 'false' },
  ])
    await assert.rejects(load([{ ...fp16, ...invalid }]), /operator task/);
  await assert.rejects(
    load([fp16], { ...output, dtype: 'float64' }),
    /operator task/,
  );
});

test('operator task identity and SDK manifest honor omitted and explicit input layout', async (t) => {
  const { directory, load } = await taskFiles(t);
  const legacy = await load([fp16]);
  assert.equal(
    legacy.taskDigest,
    '2db3f7277e16409cd921a94908322698e525f3a4d76476cdfc3f73b0260eeeeb',
  );
  const task = await load([fp16, { ...fp16, contiguous: false }]);
  const sourcePath = 'kernels/source.py';
  const source = Buffer.from(
    '# λ\r\ndef kernel_function(*args): return args[0]\r\n',
  );
  await mkdir(join(directory, 'kernels'));
  await writeFile(join(directory, sourcePath), source);
  const prepare = () =>
    prepareOperatorCase({
      task,
      selected,
      execution: parseKernelExecution({
        kind: 'kernel-source',
        format: 'triton-ascend',
        entryPoint: 'kernel_function',
        artifactRef: 'source',
        directory,
        sourcePath,
        sourceDigest: createHash('sha256').update(source).digest('hex'),
      }),
      manifest: join(directory, 'sdk-input', 'manifest.json'),
      operation: 'evaluate',
    });
  await prepare();
  const manifest = JSON.parse(
    await readFile(join(directory, 'sdk-input', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.tasks[0].candidate, 'input.py');
  assert.deepEqual(
    await readFile(join(directory, 'sdk-input', manifest.tasks[0].candidate)),
    source,
  );
  assert.deepEqual(manifest.tasks[0].contract.inputs, [
    { ...fp16, contiguous: true },
    { ...fp16, contiguous: false },
  ]);
  await writeFile(join(directory, 'outside.py'), source);
  await rm(join(directory, sourcePath));
  await symlink(join(directory, 'outside.py'), join(directory, sourcePath));
  await assert.rejects(prepare(), /symbolic link/);
});
