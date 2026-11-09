import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { object } from '../../src/shared/json.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';

// End-to-end mock smoke over the kernel-opt example: the real policy,
// application lifecycle, evaluator, selector and memory agents run against
// deterministic fixtures (agent.scripted + mock mode evaluator +
// scripts/mock-lifecycle.py), so the full chain — candidate C1 adopted, C2
// rejected by the lifecycle precheck, failed measurement counted as a stale
// round, convergence, cross-run memory persistence — is exercised without an
// Ascend NPU or model credentials.
const recipePath = 'examples/artifacts/kernel-opt/recipe.mock.yaml';

test('kernel-opt mock smoke adopts the valid candidate, converges on the precheck rejection and persists the memory wiki', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-kernel-opt-smoke-'));
  const previousMemory = process.env.NGO_MEMORY_DIR;
  const previousStateRoot = process.env.RSI_NPU_STATE_ROOT;
  const memoryStore = join(root, 'memory-store');
  process.env.NGO_MEMORY_DIR = memoryStore;
  process.env.RSI_NPU_STATE_ROOT = join(root, 'npu-state');
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    if (previousMemory === undefined) delete process.env.NGO_MEMORY_DIR;
    else process.env.NGO_MEMORY_DIR = previousMemory;
    if (previousStateRoot === undefined) delete process.env.RSI_NPU_STATE_ROOT;
    else process.env.RSI_NPU_STATE_ROOT = previousStateRoot;
    await rm(root, { recursive: true, force: true });
  });
  await registerBuiltins(registry);

  const first = await manager.run(recipePath, { id: 'smoke' });
  const output = object(first.output);
  // C1 (valid tiling variant) adopted; C2 (poisoned BLOCK_SIZE=256) rejected
  // by the mock lifecycle precheck, recorded as a failed measurement and
  // counted as the single stale round allowed by convergeRounds 1.
  assert.equal(output.status, 'selected');
  assert.equal(output.stopReason, 'converged');
  assert.equal(typeof output.candidateRef, 'string');
  assert.equal(typeof output.measurementRef, 'string');
  // Pooled p50 of the fixture samples 4.7..9.5 ms (nearest-rank over 9
  // samples) for the adopted C1.
  assert.equal(output.bestValue, 6.1);
  assert.equal((output.measurementRefs as string[]).length, 2);
  assert.equal(typeof output.memoryRef, 'string');

  // The run result carries the ngo-compatible storage layout.
  const candidateFacts = await readdir(join(root, '.rsi/facts/candidates'));
  assert.ok(candidateFacts.length >= 1);
  assert.ok((await readdir(join(root, '.rsi/artifacts'))).length >= 1);

  // Cross-run memory: the reflection wiki is mirrored to NGO_MEMORY_DIR.
  const wiki = await readFile(join(memoryStore, 'memory.md'), 'utf8');
  assert.match(wiki, /BLOCK_SIZE=256/);
  assert.match(wiki, /num_stages/);

  // Resume is idempotent: a completed run replays its recorded output
  // without new evaluations.
  const resumed = await manager.run(recipePath, { id: 'smoke', resume: true });
  assert.deepEqual(resumed.output, first.output);

  // A fresh run seeds its memory wiki from the persisted directory.
  const second = await manager.run(recipePath, { id: 'smoke-reseed' });
  const reseedOutput = object(second.output);
  assert.equal(reseedOutput.status, 'selected');
  assert.equal(reseedOutput.stopReason, 'converged');
  assert.equal(typeof reseedOutput.memoryRef, 'string');
});
