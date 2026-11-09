import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { object } from '../../src/shared/json.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { loadPluginDirectories } from '../../src/runtime/loaders/plugins.js';

// End-to-end mock smoke over the external ngo plugin pack: the pack's policy,
// agent.kernel bridge and scenario run against deterministic fixtures
// (agent.scripted + mock-mode evaluator + mock-lifecycle.py), so the full
// chain — candidate C1 adopted, C2 rejected by the lifecycle precheck, failed
// measurement counted as a stale round, convergence, cross-run memory
// persistence — is exercised without an Ascend NPU or model credentials.
// Gated on NGO_RSI_PACK pointing at a ngo-agent checkout's
// src/ngo_agent/backend/rsi pack (with a built ember dist for its imports);
// skipped otherwise so plain CI stays green.
const packRoot = process.env.NGO_RSI_PACK;
const packReady =
  packRoot !== undefined &&
  existsSync(join(packRoot, 'index.mjs')) &&
  existsSync(join(packRoot, 'recipes/operator-iter-agent.recipe.mock.yaml'));

test('kernel-opt mock smoke adopts the valid candidate, converges on the precheck rejection and persists the memory wiki', async (t) => {
  if (!packReady)
    return t.skip('NGO_RSI_PACK with the ngo plugin pack is not configured');
  const root = await mkdtemp(join(tmpdir(), 'rsi-kernel-opt-smoke-'));
  const previousMemory = process.env.NGO_MEMORY_DIR;
  const previousStateRoot = process.env.RSI_NPU_STATE_ROOT;
  const previousRsiRoot = process.env.NGO_RSI_ROOT;
  const memoryStore = join(root, 'memory-store');
  process.env.NGO_MEMORY_DIR = memoryStore;
  process.env.RSI_NPU_STATE_ROOT = join(root, 'npu-state');
  // The pack's index.mjs resolves its ember imports through this variable.
  process.env.NGO_RSI_ROOT = process.env.NGO_RSI_ROOT ?? process.cwd();
  // The pack mock recipe is written with ${NGO_PACK_ROOT} placeholders so the
  // launcher can materialize it into arbitrary run directories; the smoke
  // substitutes them itself before loading.
  const template = await readFile(
    join(packRoot, 'recipes/operator-iter-agent.recipe.mock.yaml'),
    'utf8',
  );
  const recipePath = join(root, 'recipe.mock.yaml');
  await writeFile(
    recipePath,
    template.replaceAll('${NGO_PACK_ROOT}', packRoot),
  );
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    if (previousMemory === undefined) delete process.env.NGO_MEMORY_DIR;
    else process.env.NGO_MEMORY_DIR = previousMemory;
    if (previousStateRoot === undefined) delete process.env.RSI_NPU_STATE_ROOT;
    else process.env.RSI_NPU_STATE_ROOT = previousStateRoot;
    if (previousRsiRoot === undefined) delete process.env.NGO_RSI_ROOT;
    else process.env.NGO_RSI_ROOT = previousRsiRoot;
    await rm(root, { recursive: true, force: true });
  });
  await registerBuiltins(registry);
  await loadPluginDirectories(registry, [packRoot]);

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
