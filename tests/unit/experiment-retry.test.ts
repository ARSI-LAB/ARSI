import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applicationContract,
  defineContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { createServer } from '../../src/entries/web/server.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object } from '../../src/shared/json.js';

test('HTTP exposes the same single resume option and requires an existing experiment id', async () => {
  const { managerFixture } = await import('../helpers/manager-fixture.js');
  const fixture = await managerFixture(async () => ({}));
  const server = await createServer({
    manager: fixture.manager,
    registry: fixture.manager.options.registry,
  });
  try {
    const completed = await fixture.run();
    const calls = await fixture.manager.facts.list('calls');
    const request = { recipePath: String(completed.recipePath), id: 'test' };
    const removed = await server.inject({
      method: 'POST',
      url: '/api/experiments',
      payload: { ...request, retry: true },
    });
    assert.equal(removed.statusCode, 400);
    const missingId = await server.inject({
      method: 'POST',
      url: '/api/experiments',
      payload: { recipePath: request.recipePath, resume: true },
    });
    assert.equal(missingId.statusCode, 400);
    const run = fixture.manager.run.bind(fixture.manager);
    let job: Promise<JsonObject> | undefined;
    fixture.manager.run = (path, options) => {
      assert.equal(options?.resume, true);
      job = run(path, options);
      return job;
    };
    const accepted = await server.inject({
      method: 'POST',
      url: '/api/experiments',
      payload: { ...request, resume: true },
    });
    assert.equal(accepted.statusCode, 202);
    assert.ok(job);
    assert.deepEqual(await job, completed);
    assert.deepEqual(await fixture.manager.facts.list('calls'), calls);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

for (const priorStatus of ['unknown', 'running'])
  test(`retry uses current plugins and data from the failure onward (${priorStatus} receipt)`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'arsi-retry-'));
    const policyPath = join(root, 'policy.yaml');
    const recipePath = join(root, 'recipe.yaml');
    const nextRecipePath = join(root, 'fixed.yaml');
    const schema = { type: 'object' };
    const contract = defineContract({
      id: 'contract.task',
      input_schema: schema,
      output_schema: schema,
    });
    const visits: unknown[] = [];
    function setup(plugin: string, outputSchema: JsonObject = schema) {
      const registry = new Registry();
      registry.registerPolicy('test.policy', policyPath);
      registry.registerOperation({
        id: 'test.application',
        contract: applicationContract,
        configSchema: schema,
        async create() {
          return {
            async execute(input, ctx): Promise<JsonObject> {
              const request = object(input);
              if (request.action === 'acquire') {
                visits.push(['acquire', request.instanceId]);
                return {
                  action: 'acquire',
                  execution: { capability: request.capability },
                  instanceId: request.instanceId,
                };
              }
              if (request.action === 'release') {
                visits.push(['release', request.instanceId]);
                return {
                  action: 'release',
                  instanceId: request.instanceId,
                  status: 'released',
                };
              }
              visits.push('initialize');
              const ref = await ctx.artifacts.putJson({
                kind: 'file-tree',
                files: [],
              });
              return {
                action: 'initialize',
                target: {},
                capabilities: [],
                initialCandidateRef: await ctx.recordCandidate(ref, null),
              };
            },
            async dispose() {},
          };
        },
      });
      registry.registerOperation({
        id: plugin,
        contract: defineContract({ ...contract, output_schema: outputSchema }),
        configSchema: schema,
        async create(config) {
          return {
            async execute(input, ctx) {
              assert.equal(typeof ctx.callId, 'string');
              visits.push([plugin, config, input]);
              if ((input as JsonObject).step === 'work') {
                const { initialCandidateRef } = await ctx.applicationMetadata();
                await ctx.withInstance(
                  String(initialCandidateRef),
                  'test',
                  async () => {
                    if (plugin === 'test.old') throw new Error('task failed');
                  },
                );
              }
              return { plugin, config, input };
            },
            async dispose() {},
          };
        },
      });
      return {
        manager: new Manager({ registry, rootDirectory: root }),
        registry,
      };
    }
    const writePolicy = (id = 'work', changed = false, committed = false) =>
      writeFile(
        policyPath,
        JSON.stringify({
          schemaVersion: 'rsi.policy/v1',
          id: 'test.policy',
          input_schema: schema,
          output_schema: schema,
          config_schema: schema,
          require: { task: { contract: contract.id } },
          steps: [
            {
              id: 'prepare',
              type: 'invoke',
              use: 'task',
              with: { step: 'prepare', value: '${{ config.value }}' },
            },
            {
              id: 'gate',
              type: 'if',
              if: '${{ config.enter }}',
              then: {
                steps: [
                  {
                    id: 'cycle',
                    type: 'loop',
                    maxIterations: '${{ config.iterations }}',
                    steps: [
                      {
                        id,
                        type: 'foreach',
                        foreach: '${{ config.items }}',
                        key: '${{ item }}',
                        as: 'item',
                        steps: [
                          {
                            id: 'call',
                            type: 'invoke',
                            use: 'task',
                            with: {
                              step: 'work',
                              item: '${{ item }}',
                              value: committed
                                ? '${{ config.unavailable }}'
                                : '${{ config.value }}',
                              code: changed ? 'fixed' : 'original',
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              else: {
                steps: [
                  {
                    id: 'skip',
                    type: 'invoke',
                    use: 'task',
                    with: { step: 'skip' },
                  },
                ],
              },
            },
          ],
          output: { prepare: '${{ steps.prepare.output }}' },
        }),
      );
    const writeRecipe = (path: string, plugin: string, value: string) =>
      writeFile(
        path,
        JSON.stringify({
          schemaVersion: 'rsi.recipe/v1',
          memory: false,
          reflection: false,
          id: 'test',
          application: { plugin: 'test.application', config: {} },
          policy: {
            id: 'test.policy',
            config: {
              value,
              enter: value === 'old',
              iterations: value === 'old' ? 1 : 0,
              items: value === 'old' ? ['original-item'] : [],
            },
            input: {},
          },
          bindings: { task: { plugin, config: { value } } },
        }),
      );
    const old = setup('test.old');
    const next = setup('test.new', { type: 'object', minProperties: 1 });
    const final = setup('test.new', { type: 'object', required: ['newField'] });
    try {
      await writePolicy();
      await writeRecipe(recipePath, 'test.old', 'old');
      await assert.rejects(
        old.manager.run(recipePath, { id: 'retry-test' }),
        /task failed/,
      );
      const failed = await old.manager.get('retry-test');
      const originalDefinition = await old.manager.facts.read(
        'definitions',
        'retry-test',
      );
      const work = (await old.manager.facts.list('calls')).find((call) =>
        String(call.path).includes('/work/key-'),
      )!;
      assert.equal(work.status, 'failed');
      await writeRecipe(nextRecipePath, 'test.new', 'new');
      const retry = { id: 'retry-test', resume: true };
      await writePolicy('renamed');
      await assert.rejects(
        next.manager.run(nextRecipePath, retry),
        /Policy shape/,
      );
      await writePolicy('work', true);
      const priorCall = { ...work, status: priorStatus };
      await old.manager.facts.write('calls', String(work.callId), priorCall);
      assert.deepEqual(await next.manager.get('retry-test'), failed);
      assert.deepEqual(
        await next.manager.facts.read('definitions', 'retry-test'),
        originalDefinition,
      );
      const write = next.manager.facts.write.bind(next.manager.facts);
      await write('cleanup', 'retry-test', {
        experimentId: 'retry-test',
        status: 'unconfirmed',
      });
      next.manager.facts.write = async (kind, id, value) => {
        if (kind === 'checkpoint-entries' && value.path === work.path)
          throw new Error('checkpoint write failed after call committed');
        await write(kind, id, value);
      };
      await assert.rejects(
        next.manager.run(nextRecipePath, retry),
        /checkpoint write failed/,
      );
      next.manager.facts.write = write;
      await writePolicy('work', true, true);
      await writeRecipe(nextRecipePath, 'test.new', 'latest');
      const success = await final.manager.run(nextRecipePath, retry);
      assert.equal(success.status, 'succeeded');
      assert.deepEqual(success.output, {
        prepare: {
          plugin: 'test.old',
          config: { value: 'old' },
          input: { step: 'prepare', value: 'old' },
        },
      });
      const business = visits.filter(
        (entry) =>
          !Array.isArray(entry) || !['acquire', 'release'].includes(entry[0]),
      );
      assert.deepEqual(business, [
        'initialize',
        ['test.old', { value: 'old' }, { step: 'prepare', value: 'old' }],
        [
          'test.old',
          { value: 'old' },
          {
            step: 'work',
            item: 'original-item',
            value: 'old',
            code: 'original',
          },
        ],
        [
          'test.new',
          { value: 'new' },
          { step: 'work', item: 'original-item', value: 'new', code: 'fixed' },
        ],
      ]);
      const leases = visits.filter(
        (entry) =>
          Array.isArray(entry) && ['acquire', 'release'].includes(entry[0]),
      ) as string[][];
      assert.deepEqual(
        leases.map(([action]) => action),
        ['acquire', 'release', 'acquire', 'release'],
      );
      assert.equal(leases[0]![1], leases[1]![1]);
      assert.equal(leases[2]![1], leases[3]![1]);
      assert.notEqual(leases[0]![1], leases[2]![1]);
      const receipt = await next.manager.facts.read(
        'calls',
        String(work.callId),
      );
      assert.equal(receipt.pluginId, 'test.new');
      assert.equal(receipt.status, 'succeeded');
      assert.deepEqual(receipt.output, {
        plugin: 'test.new',
        config: { value: 'new' },
        input: {
          step: 'work',
          item: 'original-item',
          value: 'new',
          code: 'fixed',
        },
      });
      assert.deepEqual(
        await next.manager.facts.read(
          'call-attempts',
          String(receipt.recoveredFrom),
        ),
        priorCall,
      );
      assert.deepEqual(await next.manager.run(nextRecipePath, retry), success);
    } finally {
      for (const { manager, registry } of [old, next, final]) {
        await manager.dispose();
        await registry.dispose();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

test('retry continues cancelled and interrupted experiments using the current Recipe', async () => {
  const { managerFixture } = await import('../helpers/manager-fixture.js');
  const fixture = await managerFixture(async () => ({}));
  try {
    await fixture.run();
    const completed = await fixture.manager.get('test');
    for (const status of ['cancelled', 'running', 'failed']) {
      await fixture.manager.facts.write('experiments', 'test', {
        ...completed,
        status,
      });
      const result = await fixture.manager.run(String(completed.recipePath), {
        id: 'test',
        resume: true,
      });
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(result.output, completed.output);
      assert.deepEqual(result.usage, completed.usage);
    }
  } finally {
    await fixture.dispose();
  }
});

test('retry reuses committed child calls before repeating the failed parent', async () => {
  const { managerFixture } = await import('../helpers/manager-fixture.js');
  let childExecutions = 0;
  let parentExecutions = 0;
  const fixture = await managerFixture(
    async (context) => {
      const result = await context.invoke('child', {});
      if (++parentExecutions === 1)
        throw new Error('parent failed after child committed');
      return result;
    },
    {
      plugins: [
        {
          id: 'test.child',
          contract: defineContract({
            id: 'contract.test-child',
            input_schema: { type: 'object' },
            output_schema: { type: 'object' },
          }),
          configSchema: { type: 'object' },
          async create() {
            return {
              async execute() {
                return { execution: ++childExecutions };
              },
              async dispose() {},
            };
          },
        },
      ],
      bindings: { child: { plugin: 'test.child', config: {} } },
    },
  );
  try {
    await assert.rejects(fixture.run(), /parent failed/);
    const failed = await fixture.manager.get('test');
    const result = await fixture.manager.run(String(failed.recipePath), {
      id: 'test',
      resume: true,
    });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.output, { execution: 1 });
    assert.equal(parentExecutions, 2);
    assert.equal(childExecutions, 1);
  } finally {
    await fixture.dispose();
  }
});

test('resume rejects earlier definition lock formats before modifying the experiment', async () => {
  const { managerFixture } = await import('../helpers/manager-fixture.js');
  const fixture = await managerFixture(async () => ({}));
  try {
    const recorded = await fixture.run();
    const definition = await fixture.manager.facts.read('definitions', 'test');
    const failed = { ...recorded, status: 'failed' };
    await fixture.manager.facts.write('experiments', 'test', failed);
    for (const version of [
      'rsi.definition-lock/v1',
      'rsi.definition-lock/v2',
    ]) {
      await fixture.manager.facts.write('definitions', 'test', {
        ...definition,
        schemaVersion: version,
      });
      await assert.rejects(
        fixture.manager.run(String(recorded.recipePath), {
          id: 'test',
          resume: true,
        }),
        /Unsupported experiment definition lock.*requires rsi\.definition-lock\/v3/,
      );
    }
    assert.deepEqual(await fixture.manager.get('test'), failed);
    assert.deepEqual(
      await fixture.manager.facts.list('definition-attempts'),
      [],
    );
  } finally {
    await fixture.dispose();
  }
});
