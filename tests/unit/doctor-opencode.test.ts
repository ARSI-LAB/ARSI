import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime } from '../../src/runtime/context.js';
import type { DoctorContext } from '../../src/contracts/index.js';
import { openCodeDefinition } from '../../src/plugins/agent-opencode/index.js';

test('OpenCode doctor composes native configuration and rejects V1 without claiming model access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-doctor-'));
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const binding = {
    name: 'agent',
    pluginId: 'agent.opencode',
    definition: openCodeDefinition,
    config: { executable: resolve('tests/fixtures/opencode-cli.cjs') },
  };
  const context: DoctorContext = {
    binding,
    recipe: {
      application: binding,
      bindings: { agent: binding },
      policyConfig: {},
    },
    registry: runtime.registry,
    runtime: runtime.context,
    directory: root,
    signal: AbortSignal.timeout(15000),
  };
  const doctor = openCodeDefinition.doctor!;
  const result = await doctor(context);
  assert.deepEqual(
    result.checks.map((c) => [c.id, c.status]),
    [
      ['executable', 'passed'],
      ['version', 'passed'],
      ['configuration', 'passed'],
      ['model-access', 'unchecked'],
    ],
  );
  const cli = join(root, 'cli.cjs');
  binding.config.executable = cli;
  for (const [version, body, failed] of [
    ['opencode v1.19.5', '[]', 'version'],
    ['opencode v2.2.7', 'native-secret-invalid-json', 'configuration'],
    ['opencode v2.2.7', '[]', 'configuration'],
  ]) {
    await writeFile(
      cli,
      `const args=process.argv.slice(2);console.log(args.includes('--help')?'--standalone --format --agent --model --archived':args.includes('--version')?${JSON.stringify(version)}:${JSON.stringify(body)});`,
    );
    const report = await doctor(context);
    assert.equal(report.checks.find((c) => c.id === failed)?.status, 'failed');
    assert(!JSON.stringify(report).includes('native-secret-invalid-json'));
    assert.equal(report.checks.at(-1)?.status, 'unchecked');
  }
});
