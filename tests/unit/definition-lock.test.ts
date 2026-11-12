import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applicationContract,
  defineContract,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { PolicyCheckpoints } from '../../src/runtime/policy/checkpoint.js';
import { object, string } from '../../src/shared/json.js';

test('interrupted experiments recover locked definitions and resources after all source files disappear', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-locked-definition-'));
  const registry = new Registry();
  const manager = new Manager({ rootDirectory: root, registry });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  let initializations = 0;
  let calls = 0;
  registry.registerOperation({
    id: 'application.test',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          initializations++;
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: 'baseline',
          };
        },
        async dispose() {},
      };
    },
  });
  registry.registerOperation({
    id: 'reader',
    contract: defineContract({
      id: 'contract.reader',
      input_schema: { type: 'object' },
      output_schema: { type: 'string' },
    }),
    configSchema: {
      type: 'object',
      properties: { 'prompt/source': { type: 'string', 'x-rsi-path': 'file' } },
      required: ['prompt/source'],
      additionalProperties: false,
    },
    async create(config, context) {
      context.event.on('rsi/policy-step-completed', (event) => {
        if (event.stepPath === 'steps/first')
          controller.abort(new Error('pause after saved step'));
      });
      return {
        async execute(_input, ctx) {
          calls++;
          assert.equal(Reflect.get(ctx, 'phase'), undefined);
          return readFile(string(config['prompt/source']), 'utf8');
        },
        async dispose() {},
      };
    },
  });
  const prompt = join(root, 'prompt.md');
  const policy = join(root, 'policy.yaml');
  const recipe = join(root, 'recipe.yaml');
  await writeFile(prompt, 'locked original');
  await writeFile(
    policy,
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.locked',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { reader: { contract: 'contract.reader' } },
      defaults: {
        bindings: {
          reader: {
            plugin: 'reader',
            config: { 'prompt/source': './prompt.md' },
          },
        },
      },
      steps: [
        { id: 'first', type: 'invoke', use: 'reader' },
        { id: 'second', type: 'invoke', use: 'reader' },
      ],
      output: {
        first: '${{ steps.first.output }}',
        second: '${{ steps.second.output }}',
      },
    }),
  );
  registry.registerPolicy('policy.locked', policy);
  await writeFile(
    recipe,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'recipe.locked',
      application: { plugin: 'application.test' },
      policy: { id: 'policy.locked' },
    }),
  );
  await assert.rejects(
    manager.run(recipe, { id: 'locked', signal: controller.signal }),
    /pause after saved step/,
  );
  await manager.facts.write('experiments', 'locked', {
    ...(await manager.get('locked')),
    startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  await Promise.all([rm(prompt), rm(policy), rm(recipe)]);
  const restored = await manager.run(recipe, { id: 'locked', resume: true });
  assert.deepEqual(restored.output, {
    first: 'locked original',
    second: 'locked original',
  });
  assert.equal(calls, 2);
  assert.equal(initializations, 1);
  const lock = await manager.facts.read('definitions', 'locked');
  await manager.facts.write('definitions', 'locked', {
    ...lock,
    recipe: { ...object(lock.recipe), id: 'tampered' },
  });
  await assert.rejects(
    manager.run(recipe, { id: 'locked', resume: true }),
    /digest mismatch/,
  );
});

test('Manager resumes after a committed loop boundary without replaying calls', async () => {
  const { managerFixture } = await import('../helpers/manager-fixture.js');
  const controller = new AbortController();
  let executions = 0;
  const fixture = await managerFixture(async (context) => {
    executions++;
    context.event.on('rsi/policy-boundary-completed', (event) => {
      if (event.iteration === 0)
        controller.abort(new Error('pause after loop boundary'));
      return undefined;
    });
    return {};
  });
  try {
    const policyPath = join(fixture.manager.rootDirectory, 'policy.yaml');
    const recipePath = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: { driver: { contract: 'contract.test-driver' } },
        steps: [
          {
            id: 'rounds',
            type: 'loop',
            maxIterations: 2,
            steps: [{ id: 'drive', type: 'invoke', use: 'driver' }],
          },
        ],
        output: {},
      }),
    );
    await assert.rejects(
      fixture.manager.run(recipePath, {
        id: 'mid-loop',
        signal: controller.signal,
      }),
      /pause after loop boundary/,
    );
    const checkpoint = await new PolicyCheckpoints(
      fixture.manager.facts,
      'mid-loop',
    ).restore();
    assert(checkpoint);
    assert(Object.values(object(checkpoint.boundaries)).includes(true));
    assert.equal(
      (await fixture.manager.run(recipePath, { id: 'mid-loop', resume: true }))
        .status,
      'succeeded',
    );
    assert.equal(executions, 2);
  } finally {
    await fixture.dispose();
  }
});

test('resource URLs exclude Windows drive paths while preserving actual URL schemes', async () => {
  const { isResourceUrl } = await import('../../src/shared/paths.js');
  for (const local of [
    'C:/data/prompt.md',
    'D:\\data\\prompt.md',
    '/data/prompt.md',
    './prompt.md',
    '\\\\host\\share\\prompt.md',
  ])
    assert.equal(isResourceUrl(local), false, local);
  for (const remote of [
    'https://example.test/data',
    'file:///tmp/data',
    'artifact:abc',
  ])
    assert.equal(isResourceUrl(remote), true, remote);
});
