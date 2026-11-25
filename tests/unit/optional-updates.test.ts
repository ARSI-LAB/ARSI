import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
import { join } from 'node:path';
import {
  parseFileTree,
  memoryContract,
  agentContract,
  type JsonObject,
  type OperationDefinition,
  type RuntimeContext,
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture as baseFixture } from '../helpers/manager-fixture.js';

function generator(
  execute: (input: JsonObject, ctx: RuntimeContext) => Promise<JsonObject>,
): OperationDefinition {
  return {
    id: 'test.memory',
    contract: memoryContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        execute: (input, ctx) => execute(object(input), ctx),
        async dispose() {},
      };
    },
  };
}
async function proposal(
  ctx: RuntimeContext,
  content: string,
  path = 'notes.md',
): Promise<JsonObject> {
  return {
    status: 'updated',
    reason: 'Observed experience',
    changeRef: await ctx.artifacts.putJson({ path }),
    resourceRef: await ctx.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path,
          mode: process.platform === 'win32' ? 0o666 : 0o644,
          base64: Buffer.from(content).toString('base64'),
        },
      ],
    }),
  };
}
const memory: JsonObject = {
  implementation: { ref: 'test.memory' },
  evidence: { includeSteps: ['deliver'] },
};
function policy(settings: JsonObject): JsonObject {
  return {
    defaults: { memory: settings, reflection: false },
    steps: [
      {
        id: 'rounds',
        type: 'loop',
        maxIterations: 3,
        steps: [{ id: 'deliver', type: 'invoke', use: 'driver' }],
      },
    ],
    output: {},
  };
}
async function managerFixture(
  run: Parameters<typeof baseFixture>[0],
  options: NonNullable<Parameters<typeof baseFixture>[1]> & {
    policy: JsonObject;
  },
): ReturnType<typeof baseFixture> {
  const defaults = object(options.policy.defaults);
  const fixture = await baseFixture(run, {
    ...options,
    policy: {
      ...options.policy,
      defaults: { reflection: false, memory: { configFile: './memory.yaml' } },
    },
  });
  await writeFile(
    join(fixture.manager.rootDirectory, 'memory.yaml'),
    stringify(defaults.memory),
  );
  return fixture;
}
test('Memory reaches Agent projects through the pinned caller version and leaves the source project intact', async (t) => {
  let generations = 0;
  const delivered: string[] = [];
  const pointers: string[] = [];
  let firstCall: RuntimeContext | undefined;
  const agent: OperationDefinition = {
    id: 'test.memory-reader',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input) {
          const cwd = string(object(input).cwd);
          assert.match(
            cwd.replaceAll('\\', '/'),
            /agent-projects\/[a-f0-9]{64}\/project$/,
          );
          for (const instructions of ['AGENTS.md', 'CLAUDE.md']) {
            const path = join(cwd, instructions);
            assert.equal((await lstat(path)).mode & 0o222, 0);
            assert.match(
              await readFile(path, 'utf8'),
              /Experiment Memory \(Read-Only\)[\s\S]*context\/memory\/notes.md/,
            );
          }
          delivered.push(
            await readFile(join(cwd, 'context/memory/notes.md'), 'utf8'),
          );
          return {};
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (ctx) => {
      ctx.event.on('rsi/memory-activated', (e) => {
        pointers.push(e.memoryVersionRef);
      });
      if (!firstCall) {
        firstCall = ctx;
        return {};
      }
      for (const caller of delivered.length ? [ctx] : [firstCall, ctx]) {
        const cwd = await prepareAgentProject(
          caller,
          'Work on this task',
          {},
          [],
          [],
        );
        for (const instructions of ['AGENTS.md', 'CLAUDE.md'])
          await chmod(join(cwd, instructions), 0o444);
        await caller.invokeAgent('reader', {
          cwd,
          goal: 'Inspect',
          outputSchema: {},
        });
        await assert.rejects(readFile(join(cwd, 'context/memory/notes.md')), {
          code: 'ENOENT',
        });
        for (const instructions of ['AGENTS.md', 'CLAUDE.md']) {
          const path = join(cwd, instructions);
          assert.equal((await lstat(path)).mode & 0o222, 0);
          assert.equal(await readFile(path, 'utf8'), 'Work on this task\n');
        }
      }
      return {};
    },
    {
      plugins: [
        agent,
        generator(async (input, ctx) => {
          assert.ok(input.parentVersionRef && input.resourceRef);
          await assert.rejects(
            ctx.recordCandidate('artifact:ignored', null),
            /cannot create Application candidates/,
          );
          if (++generations === 2) throw new Error('Model unavailable');
          return proposal(ctx, 'new experience');
        }),
      ],
      bindings: { reader: { plugin: agent.id, config: {} } },
      policy: policy({
        ...memory,
        directory: './seed',
        targets: { include: ['driver'] },
      }),
    },
  );
  t.after(() => fixture.dispose());
  const { manager } = fixture,
    root = manager.rootDirectory;
  await mkdir(join(root, 'seed'));
  await writeFile(join(root, 'seed/notes.md'), 'seeded');
  const record = await fixture.run();
  assert.deepEqual(delivered, ['seeded', 'new experience', 'new experience']);
  const runs = await manager.facts.list('evolution-runs');
  assert.equal(runs.filter((r) => r.status === 'rejected').length, 1);
  const versions = await manager.facts.list('memory-revisions');
  const initial = versions.find((v) => v.kind === 'initial')!;
  const generated = versions.find((v) => v.kind === 'generated')!;
  assert.equal(versions.length, 2);
  assert.equal(generated.parentRef, initial.ref);
  assert.equal(generated.rootRef, initial.ref);
  assert.equal(generated.ref, object(record.evolution).memoryRef);
  assert.ok(pointers.includes(string(generated.ref)));
  const agentCalls = (await manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'reader',
  );
  assert.deepEqual(
    agentCalls.map((c) => object(c.metadata).memoryVersionRef).sort(),
    [initial.ref, generated.ref, generated.ref].sort(),
  );
  assert.equal(await readFile(join(root, 'seed/notes.md'), 'utf8'), 'seeded');
  await manager.memory().apply(string(generated.ref));
  assert.equal(
    await readFile(join(root, 'seed/notes.md'), 'utf8'),
    'new experience',
  );
});
test('Agent middleware sees the prepared Memory and cached workspaces retain the pinned read-only files', async (t) => {
  for (const mode of ['seeded', 'excluded', 'empty'])
    await t.test(mode, async (t) => {
      const enabled = mode === 'seeded';
      let backendCalls = 0;
      const reader: OperationDefinition = {
        id: 'test.memory-reader',
        contract: agentContract,
        configSchema: { type: 'object' },
        async create() {
          return {
            async execute(input, context) {
              backendCalls++;
              assert.equal(object(input).goal, 'checked');
              assert.equal(context.agentProject, object(input).cwd);
              return { cwd: object(input).cwd! };
            },
            async dispose() {},
          };
        },
      };
      const fixture = await managerFixture(
        async (ctx) => {
          const cwd = await prepareAgentProject(ctx, 'Inspect', {}, [], []);
          ctx.event.on('rsi/before-agent-invoke', async (_event, next) => {
            const current = await next();
            assert.equal(current.kind, 'proceed');
            assert.equal(!!current.metadata?.memoryVersionRef, enabled);
            assert.equal(current.input.cwd === cwd, !enabled);
            return { ...current, input: { ...current.input, goal: 'checked' } };
          });
          if (enabled)
            ctx.event.on('rsi/before-call', async (event, next) => {
              const decision = await next();
              return event.bindingId === 'reader' && decision.kind === 'proceed'
                ? {
                    ...decision,
                    metadata: { memoryVersionRef: 'unrelated', audited: true },
                  }
                : decision;
            });
          const request = { cwd, goal: 'inspect', outputSchema: {} };
          const result = await ctx.invokeAgent('reader', request);
          const path = join(string(result.cwd), 'context/memory/lesson.md');
          const receipt = (await ctx.facts.list('calls')).find(
            (c) => c.bindingId === 'reader',
          )!;
          const project = parseFileTree(
            await ctx.artifacts.readJson(
              string(receipt.agentProjectArtifactRef),
            ),
          );
          const lesson = project.files.find(
            (file) => file.path === 'context/memory/lesson.md',
          );
          if (enabled) {
            assert.ok(lesson);
            assert.equal(lesson.mode & 0o222, 0);
            assert.equal((await lstat(path)).mode & 0o222, 0);
            assert.equal(object(receipt.metadata).audited, true);
            assert.notEqual(
              object(receipt.metadata).memoryVersionRef,
              'unrelated',
            );
            await chmod(path, 0o666);
            await writeFile(path, 'changed after first execution');
            await assert.rejects(
              ctx.invokeAgent('reader', request),
              /modified experiment Memory/,
            );
          } else {
            assert.equal(lesson, undefined);
            assert.equal(receipt.metadata, undefined);
            await assert.rejects(readFile(path), { code: 'ENOENT' });
          }
          return {};
        },
        {
          plugins: [
            reader,
            generator(async (input) => ({
              status: 'no-change',
              resourceRef: input.resourceRef!,
              changeRef: null,
              reason: 'unchanged',
            })),
          ],
          bindings: { reader: { plugin: reader.id, config: {} } },
          policy: {
            defaults: {
              memory: {
                implementation: { ref: 'test.memory' },
                directory: './source',
                ...(mode === 'excluded'
                  ? { targets: { exclude: ['driver'] } }
                  : {}),
              },
            },
            steps: [{ id: 'inspect', type: 'invoke', use: 'driver' }],
            output: {},
          },
        },
      );
      t.after(() => fixture.dispose());
      if (mode !== 'empty') {
        await mkdir(join(fixture.manager.rootDirectory, 'source'));
        await writeFile(
          join(fixture.manager.rootDirectory, 'source/lesson.md'),
          'original',
        );
      }
      await fixture.run();
      assert.equal(backendCalls, 1);
    });
});

test('global cancellation and budget errors stop evolution; a local model cap rejects only that invocation', async (t) => {
  for (const mode of ['cancel', 'global', 'local', 'ledger'])
    await t.test(mode, async (t) => {
      const controller = new AbortController();
      const fixture = await managerFixture(async () => ({}), {
        plugins: [
          generator(async (_input, ctx) => {
            if (mode === 'cancel') {
              controller.abort(new Error('cancelled experiment'));
              ctx.signal.throwIfAborted();
            }
            await ctx.charge('modelCalls', 1);
            return proposal(ctx, 'survived');
          }),
        ],
        budget: { modelCalls: mode === 'global' ? 0 : 10 },
        policy: policy({
          ...memory,
          ...(mode === 'local' ? { budget: { modelCalls: 0 } } : {}),
        }),
      });
      t.after(() => fixture.dispose());
      const { manager } = fixture,
        path = join(manager.rootDirectory, 'recipe.yaml');
      if (mode === 'ledger') {
        const write = manager.facts.write.bind(manager.facts);
        manager.facts.write = async (kind, id, fact) => {
          if (kind === 'budgets' && fact.modelCalls === 1)
            throw new Error('ledger unavailable');
          await write(kind, id, fact);
        };
      }
      if (mode === 'local') {
        assert.equal((await fixture.run()).status, 'succeeded');
        assert.ok(
          (await manager.facts.list('evolution-runs')).every(
            (r) => r.status === 'rejected',
          ),
        );
      } else {
        await assert.rejects(
          manager.run(path, { id: 'test', signal: controller.signal }),
          mode === 'cancel'
            ? /cancelled/
            : mode === 'global'
              ? /Budget exceeded/
              : /ledger unavailable/,
        );
        assert.equal(
          (await manager.get('test')).status,
          mode === 'cancel' ? 'cancelled' : 'failed',
        );
      }
    });
});

for (const boundary of [
  'evidence-prepared',
  'prepared',
  'generator-receipt',
  'validated',
  'activation',
  'activated',
] as const) {
  test('Memory resumes at the ' + boundary + ' boundary', async (t) => {
    let generations = 0,
      deliveries = 0;
    const fixture = await managerFixture(
      async () => {
        deliveries++;
        return {};
      },
      {
        plugins: [
          generator(async (_input, ctx) => {
            generations++;
            return proposal(ctx, 'experience');
          }),
        ],
        policy: {
          defaults: {
            memory: {
              ...memory,
              trigger: { on: 'after-step', step: 'deliver' },
            },
          },
          steps: [{ id: 'deliver', type: 'invoke', use: 'driver' }],
          output: {},
        },
      },
    );
    t.after(() => fixture.dispose());
    const { manager } = fixture,
      path = join(manager.rootDirectory, 'recipe.yaml');
    const controller = new AbortController();
    const write = manager.facts.write.bind(manager.facts);
    manager.facts.write = async (kind, id, data) => {
      await write(kind, id, data);
      const phase = boundary;
      if (
        (kind === 'evolution-runs' && data.status === phase) ||
        (phase === 'generator-receipt' &&
          kind === 'calls' &&
          data.bindingId === '_memory' &&
          data.status === 'succeeded') ||
        (phase === 'activation' &&
          kind === 'activations' &&
          data.memory &&
          object(data.memory).ref !== object(data.memory).rootRef)
      )
        controller.abort(new Error('interrupted at ' + boundary));
    };
    await assert.rejects(
      manager.run(path, { id: 'recovery', signal: controller.signal }),
      /interrupted/,
    );
    manager.facts.write = write;
    const result = await manager.run(path, { id: 'recovery', resume: true });
    assert.equal(deliveries, 1);
    assert.equal(generations, 1);
    const versions = await manager.facts.list('memory-revisions');
    assert.equal(versions.length, 2);
    assert.equal(
      object(result.evolution).memoryRef,
      versions.find((v) => v.kind === 'generated')!.ref,
    );
  });
}

test('an evolution deadline permits the next step while the generator lease drains', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveries = 0;
  const fixture = await managerFixture(
    async () => {
      if (++deliveries === 2) release();
      return {};
    },
    {
      budget: { modelCalls: 0 },
      plugins: [
        generator(async (_input, ctx) => {
          await gate;
          await ctx.charge('modelCalls', 1);
          return proposal(ctx, 'late');
        }),
      ],
      policy: {
        defaults: {
          memory: {
            ...memory,
            trigger: { on: 'after-step', step: 'deliver' },
            budget: { timeoutSeconds: 1 },
          },
        },
        steps: [
          { id: 'deliver', type: 'invoke', use: 'driver' },
          { id: 'next', type: 'invoke', use: 'driver' },
        ],
        output: {},
      },
    },
  );
  t.after(async () => {
    release();
    await fixture.dispose();
  });
  const result = await fixture.run();
  assert.equal(deliveries, 2);
  assert.equal(
    object(result.evolution).memoryRef,
    (await fixture.manager.facts.list('memory-revisions'))[0]?.ref,
  );
  assert.equal(
    (await fixture.manager.facts.list('evolution-runs'))[0]?.status,
    'rejected',
  );
  assert.equal(
    (await fixture.manager.facts.list('calls')).find(
      (c) => c.bindingId === '_memory',
    )?.status,
    'cancelled',
  );
});

test('Memory rejects file and directory collisions before a custom proposal becomes active', async (t) => {
  const fixture = await managerFixture(async () => ({}), {
    plugins: [
      generator(async (_input, ctx) => ({
        status: 'updated',
        reason: 'bad tree',
        changeRef: await ctx.artifacts.putJson({}),
        resourceRef: await ctx.artifacts.putJson({
          kind: 'file-tree',
          files: ['notes', 'notes/example'].map((path) => ({
            path,
            base64: '',
            mode: 0o644,
          })),
        }),
      })),
    ],
    policy: policy(memory),
  });
  t.after(() => fixture.dispose());
  const record = await fixture.run();
  const versions = await fixture.manager.facts.list('memory-revisions');
  assert.equal(versions.length, 1);
  assert.equal(object(record.evolution).memoryRef, versions[0]!.ref);
  assert.ok(
    (await fixture.manager.facts.list('evolution-runs')).every(
      (r) =>
        r.status === 'rejected' &&
        String(r.reason).includes('also a directory'),
    ),
  );
});
