import { diagnoseBinding } from '../../src/runtime/doctor/index.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DoctorContext,
  DoctorResult,
  JsonObject,
} from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { optunaProposerDefinition } from '../../src/plugins/proposer-optuna/index.js';
import { createOptunaProposer } from '../../src/plugins/proposer-optuna/service.js';
import { parseOptunaConfig } from '../../src/plugins/proposer-optuna/schema.js';
import type { OptunaWorker } from '../../src/plugins/proposer-optuna/worker.js';

type Probe = DoctorContext & { recipe: Recipe; registry: Registry };

function runDoctor(context: Probe): Promise<DoctorResult> {
  return diagnoseBinding(context.registry, context);
}

async function runOptunaDoctor(
  context: DoctorContext,
  worker: OptunaWorker,
): Promise<DoctorResult> {
  const registry = new Registry();
  registry.registerOperation({
    ...optunaProposerDefinition,
    create: (config, runtime) =>
      createOptunaProposer(parseOptunaConfig(config), runtime, worker),
  });
  try {
    return await diagnoseBinding(registry, { ...context, registry });
  } finally {
    await registry.dispose();
  }
}

async function fixture(t: TestContext): Promise<{
  root: string;
  prompt: string;
  probe(id: string, config: JsonObject): Probe;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-doctor-business-'));
  const runtime = await createRuntime({
    rootDirectory: root,
    homeDirectory: false,
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const baseline = join(root, 'baseline');
  await mkdir(baseline);
  const prompt = join(root, 'prompt.md');
  await writeFile(prompt, 'Use the supplied evidence.');
  await writeFile(join(baseline, 'module.md'), 'Original prompt.');
  await writeFile(join(baseline, 'params.json'), '{"size":1}\n');
  const policy = new Policy(
    {
      schemaVersion: 'rsi.policy/v1',
      id: 'doctor-business',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { agent: { contract: 'contract.agent' } },
      steps: [],
      output: {},
    },
    { contracts: runtime.registry },
  );
  const recipe = await Recipe.fromJSON(
    {
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-business',
      application: {
        plugin: 'application.agentbundle',
        config: {
          target: { schema: join(root, 'target.yaml') },
          baseline: { directory: baseline },
        },
      },
      policy: { id: policy.id },
      bindings: { agent: { plugin: 'agent.pi', config: {} } },
    },
    runtime.registry,
    { policy },
  );
  return {
    root,
    prompt,
    probe(id, config) {
      const signal = new AbortController().signal;
      return {
        binding: {
          name: 'probe',
          pluginId: id,
          config,
          definition: runtime.registry.get(id),
        },
        recipe,
        registry: runtime.registry,
        runtime: runtime.context.extend({
          directory: join(root, 'probe'),
          signal,
        }),
        directory: join(root, 'probe'),
        signal,
      };
    },
  };
}

for (const id of [
  'proposer.agent',
  'memory.agent',
  'reflection.agent',
  'selector.artifact',
]) {
  test(`${id} prepares an editing project without invoking an Agent and reports a missing prompt`, async (t) => {
    const f = await fixture(t);
    const working = f.probe(id, { agentRef: 'agent', prompt: f.prompt });
    const workingResult = await runDoctor(working);
    assert.deepEqual(
      workingResult.checks.map((check) => check.status),
      ['passed', 'passed'],
    );
    const projects = await readdir(join(f.root, 'probe/agent-projects'));
    const instructions = await readFile(
      join(f.root, 'probe/agent-projects', projects[0]!, 'project/AGENTS.md'),
      'utf8',
    );
    assert.match(instructions, /supplied evidence/);
    if (id === 'reflection.agent')
      assert.match(instructions, /reflection-reviewer/);
    assert.deepEqual(await working.runtime.facts.list('experiments'), []);
    assert.deepEqual(await working.runtime.facts.list('measurements'), []);

    const broken = f.probe(id, {
      agentRef: 'agent',
      prompt: join(f.root, 'missing.md'),
    });
    const brokenResult = await runDoctor(broken);
    assert.deepEqual(
      await readdir(join(f.root, 'probe/agent-projects')),
      projects,
    );
    assert.equal(
      brokenResult.checks.find((check) => check.id === 'editing-inputs')
        ?.status,
      'failed',
    );
    assert.equal(
      brokenResult.checks.find((check) => check.id === 'prepare-project')
        ?.status,
      'unchecked',
    );
    assert.ok(
      brokenResult.checks
        .find(({ id }) => id === 'editing-inputs')
        ?.reason?.includes(join(f.root, 'missing.md')),
    );
  });
}

test('editor checks diagnose missing skill instructions and reject duplicate roles and skills', async (t) => {
  const f = await fixture(t);
  const missingSkill = f.probe('memory.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    skills: [join(f.root, 'missing-skill')],
  });
  const missingSkillResult = await runDoctor(missingSkill);
  const reason = missingSkillResult.checks.find(
    ({ id }) => id === 'editing-inputs',
  )?.reason;
  assert.match(reason ?? '', /Missing file.*SKILL\.md.*correct skills\.0/);

  const role = { name: 'reviewer', description: 'Review', prompt: f.prompt };
  const duplicateRoles = f.probe('proposer.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    subagents: [role, role],
  });
  const duplicateRolesResult = await runDoctor(duplicateRoles);
  assert.match(
    duplicateRolesResult.checks.at(-1)!.reason!,
    /duplicate agent role/,
  );

  const skill = join(f.root, 'skill');
  await mkdir(skill);
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: reviewer\ndescription: Review\n---\nInstructions.',
  );
  const duplicateSkills = f.probe('selector.artifact', {
    agentRef: 'agent',
    prompt: f.prompt,
    skills: [skill, skill],
  });
  const duplicateSkillsResult = await runDoctor(duplicateSkills);
  assert.match(
    duplicateSkillsResult.checks.at(-1)!.reason!,
    /Duplicate skill name/,
  );
});

test('proposer.grid constructs a valid grid and rejects repeated axes', async (t) => {
  const f = await fixture(t);
  const axis = { name: 'size', values: [1, 2] };
  const working = f.probe('proposer.grid', {
    path: 'params.json',
    searchSpace: [axis],
  });
  const workingResult = await runDoctor(working);
  assert.deepEqual(
    workingResult.checks.map(({ status }) => status),
    ['passed', 'passed'],
  );
  const broken = f.probe('proposer.grid', {
    path: 'params.json',
    searchSpace: [axis, axis],
  });
  const brokenResult = await runDoctor(broken);
  assert.match(brokenResult.checks[0]!.reason!, /duplicate/);
  assert.deepEqual(await broken.runtime.facts.list('candidates'), []);
});

test('selector.metric checks ordinary and prerequisite constraint bounds', async (t) => {
  const f = await fixture(t);
  const working = f.probe('selector.metric', { direction: 'minimize' });
  const workingResult = await runDoctor(working);
  assert.equal(workingResult.checks[0]!.status, 'passed');
  for (const prerequisite of [false, true]) {
    const broken = f.probe('selector.metric', {
      constraints: [{ metric: 'latency', prerequisite, min: 2, max: 1 }],
    });
    const brokenResult = await runDoctor(broken);
    assert.match(brokenResult.checks[0]!.reason!, /min exceeds max/);
  }
});

test('proposer.pareto-evolution checks module identities and the real baseline files', async (t) => {
  const f = await fixture(t);
  const config = {
    maxRounds: 1,
    maxRollouts: 2,
    minibatchSize: 1,
    paretoSize: 1,
    seed: 0,
    crossoverEvery: 0,
    goal: 'Improve prompt',
    modules: [{ id: 'module', path: 'module.md' }],
  };
  const working = f.probe('proposer.pareto-evolution', config);
  const workingResult = await runDoctor(working);
  assert.deepEqual(
    workingResult.checks.map((check) => check.status),
    ['passed', 'passed'],
  );
  for (const modules of [
    [config.modules[0]!, config.modules[0]!],
    [{ id: 'unsafe', path: '../module.md' }],
  ]) {
    const broken = f.probe('proposer.pareto-evolution', { ...config, modules });
    const brokenResult = await runDoctor(broken);
    assert.equal(brokenResult.checks[0]!.status, 'failed');
    assert.equal(brokenResult.checks.length, 2);
    assert.equal(brokenResult.checks[1]!.status, 'unchecked');
  }
  const missing = f.probe('proposer.pareto-evolution', {
    ...config,
    modules: [{ id: 'missing', path: 'missing.md' }],
  });
  const missingResult = await runDoctor(missing);
  assert.deepEqual(
    missingResult.checks.map((check) => check.status),
    ['passed', 'failed'],
  );
  assert.ok(
    missingResult.checks
      .find(({ id }) => id === 'baseline-modules')
      ?.reason?.includes(join(f.root, 'baseline/missing.md')),
  );

  const artifact = f.probe('proposer.pareto-evolution', config);
  const artifactRef = await artifact.runtime.artifacts.capture(
    join(f.root, 'baseline'),
  );
  artifact.recipe = await Recipe.fromJSON(
    {
      ...artifact.recipe.toJSON(),
      application: {
        plugin: 'application.agentbundle',
        config: { target: { schema: {} }, baseline: { artifactRef } },
      },
    },
    artifact.registry,
    { policy: artifact.recipe.policy },
  );
  const artifactResult = await runDoctor(artifact);
  assert.deepEqual(
    artifactResult.checks.map((check) => check.status),
    ['passed', 'passed'],
  );
});

test('proposer.optuna requests only the dependency check and rejects wrong dependency versions', async (t) => {
  const f = await fixture(t);
  const config = {
    path: 'params.json',
    sampler: { type: 'random' },
    searchSpace: [
      { name: 'size', distribution: 'categorical', values: [1, 2] },
    ],
  };
  const working = f.probe('proposer.optuna', config);
  const workingResult = await runOptunaDoctor(
    working,
    async (_config, request) => {
      assert.equal(request.action, 'check');
      assert.deepEqual(request.history, []);
      return {
        environment: { python: '3.13.1', optuna: '4.5.0', numpy: '2.2.6' },
      };
    },
  );
  assert.deepEqual(
    workingResult.checks.map(({ status }) => status),
    ['passed', 'passed'],
  );
  const incompatible = f.probe('proposer.optuna', config);
  const incompatibleResult = await runOptunaDoctor(incompatible, async () => ({
    environment: { python: '3.13.1', optuna: '4.4.0', numpy: '2.2.6' },
  }));
  assert.equal(
    incompatibleResult.checks.find(({ id }) => id === 'python-dependencies')!
      .status,
    'failed',
  );
  const missing = f.probe('proposer.optuna', {
    ...config,
    python: { executable: join(f.root, 'missing-python') },
  });
  const missingResult = await runDoctor(missing);
  assert.equal(
    missingResult.checks.find(({ id }) => id === 'python-dependencies')!.status,
    'failed',
  );
  assert.match(
    missingResult.checks.find(({ id }) => id === 'python-dependencies')!
      .reason!,
    /ENOENT/,
  );
});

test('parameter doctors reject unreadable or invalid baseline JSON before Optuna probes Python', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'baseline/params.json');
  let calls = 0;
  const worker: OptunaWorker = async () => {
    calls++;
    return {
      environment: { python: '3.13.1', optuna: '4.5.0', numpy: '2.2.6' },
    };
  };
  for (const content of [undefined, '{broken', '[]', 'null', '42']) {
    if (content === undefined) await rm(file);
    else await writeFile(file, content);
    for (const id of ['proposer.grid', 'proposer.optuna']) {
      const context = f.probe(
        id,
        id === 'proposer.grid'
          ? {
              path: 'params.json',
              searchSpace: [{ name: 'size', values: [1, 2] }],
            }
          : {
              path: 'params.json',
              sampler: { type: 'random' },
              searchSpace: [
                { name: 'size', distribution: 'categorical', values: [1, 2] },
              ],
            },
      );
      const report =
        id === 'proposer.optuna'
          ? await runOptunaDoctor(context, worker)
          : await runDoctor(context);
      const parameterFile = report.checks.find(
        ({ id }) => id === 'parameter-file',
      );
      assert.equal(parameterFile?.status, 'failed', JSON.stringify(report));
      assert.match(
        parameterFile.reason ?? '',
        /restore.*JSON object.*params.json.*probe.config.path/i,
      );
      if (id === 'proposer.optuna')
        assert.equal(
          report.checks.find(({ id }) => id === 'python-dependencies')?.status,
          'unchecked',
        );
      assert.equal(calls, 0);
      assert.deepEqual(await context.runtime.facts.list('candidates'), []);
    }
  }
});

test('parameter doctors inspect relative and artifact baselines and leave unknown baselines unchecked', async (t) => {
  const f = await fixture(t);
  for (const id of ['proposer.grid', 'proposer.optuna']) {
    const source = f.probe(
      id,
      id === 'proposer.grid'
        ? {
            path: 'params.json',
            searchSpace: [{ name: 'size', values: [1, 2] }],
          }
        : {
            path: 'params.json',
            sampler: { type: 'random' },
            searchSpace: [
              { name: 'size', distribution: 'categorical', values: [1, 2] },
            ],
          },
    );
    const artifactRef = await source.runtime.artifacts.capture(
      join(f.root, 'baseline'),
    );
    const baselines: (JsonObject | undefined)[] = [
      { directory: 'baseline' },
      { artifactRef },
      undefined,
    ];
    for (const baseline of baselines) {
      const context: DoctorContext = {
        ...source,
        recipe: {
          ...source.recipe,
          application: {
            ...source.recipe.application,
            config: baseline ? { baseline } : {},
          },
        },
      };
      const report =
        id === 'proposer.optuna'
          ? await runOptunaDoctor(context, async () => ({
              environment: {
                python: '3.13.1',
                optuna: '4.5.0',
                numpy: '2.2.6',
              },
            }))
          : await diagnoseBinding(source.registry, context);
      assert.equal(
        report.checks.find(({ id }) => id === 'parameter-file')?.status,
        baseline ? 'passed' : 'unchecked',
        JSON.stringify(report),
      );
      if (baseline && 'artifactRef' in baseline)
        assert.deepEqual(
          (await readdir(context.directory)).filter((name) =>
            name.startsWith('parameter-baseline-'),
          ),
          [],
        );
      assert.deepEqual(
        await readFile(join(f.root, 'baseline/params.json'), 'utf8'),
        '{"size":1}\n',
      );
    }
  }
});

test('parameter artifact checks clean up failed and cancelled materializations before Python or fact writes', async (t) => {
  const f = await fixture(t);
  const source = f.probe('proposer.optuna', {
    path: 'params.json',
    sampler: { type: 'random' },
    searchSpace: [
      { name: 'size', distribution: 'categorical', values: [1, 2] },
    ],
  });
  const file = join(f.root, 'baseline/params.json');
  const materialize = source.runtime.artifacts.materialize.bind(
    source.runtime.artifacts,
  );
  let workerCalls = 0;
  const worker: OptunaWorker = async () => {
    workerCalls++;
    return {
      environment: { python: '3.13.1', optuna: '4.5.0', numpy: '2.2.6' },
    };
  };
  for (const outcome of [
    'invalid',
    'missing',
    'cancel-during',
    'cancel-after',
  ]) {
    if (outcome === 'missing') await rm(file);
    else await writeFile(file, outcome === 'invalid' ? '{broken' : '{}');
    const artifactRef = await source.runtime.artifacts.capture(
      join(f.root, 'baseline'),
    );
    const controller = new AbortController();
    let materializations = 0;
    const intercepted = t.mock.method(
      source.runtime.artifacts,
      'materialize',
      async (ref: string, directory: string) => {
        materializations++;
        if (outcome === 'cancel-during')
          controller.abort(new Error('Interrupted parameter materialization'));
        await materialize(ref, directory);
        if (outcome === 'cancel-after')
          controller.abort(new Error('Interrupted parameter materialization'));
      },
    );
    const context: DoctorContext = {
      ...source,
      signal: controller.signal,
      runtime: source.runtime.extend({ signal: controller.signal }),
      recipe: {
        ...source.recipe,
        application: {
          ...source.recipe.application,
          config: { baseline: { artifactRef } },
        },
      },
    };
    try {
      const diagnostic = runOptunaDoctor(context, worker);
      if (outcome.startsWith('cancel-')) {
        await assert.rejects(
          diagnostic,
          /Interrupted parameter materialization/,
        );
      } else {
        const report = await diagnostic;
        assert.equal(
          report.checks.find(({ id }) => id === 'parameter-file')?.status,
          'failed',
        );
        assert.equal(
          report.checks.find(({ id }) => id === 'python-dependencies')?.status,
          'unchecked',
        );
      }
      assert.equal(materializations, 1);
      assert.equal(workerCalls, 0);
      assert.deepEqual(
        (await readdir(context.directory)).filter((name) =>
          name.startsWith('parameter-baseline-'),
        ),
        [],
      );
      for (const kind of ['experiments', 'candidates', 'measurements'])
        assert.deepEqual(await source.runtime.facts.list(kind), []);
    } finally {
      intercepted.mock.restore();
    }
  }
});

test('proposer.operator loads task, stage prompts and knowledge without retrieval or inference', async (t) => {
  const f = await fixture(t);
  const task = join(f.root, 'task');
  const prompts = join(f.root, 'prompts');
  const resources = join(f.root, 'resources');
  await Promise.all([
    mkdir(task),
    mkdir(prompts),
    mkdir(join(resources, 'knowledge'), { recursive: true }),
  ]);
  await writeFile(
    join(task, 'task.json'),
    JSON.stringify({
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'fixture',
      cases: [{ id: 'one', seed: 0 }],
      contract: {
        inputs: [{ shape: [1], dtype: 'float16' }],
        output: {
          shape: [1],
          dtype: 'float16',
          contiguous: true,
          independent: true,
        },
        inputUnmodified: true,
      },
    }),
  );
  await writeFile(join(task, 'problem.py'), 'def kernel_function(x): return x');
  await writeFile(join(task, 'test.py'), '# fixture');
  for (const name of [
    'diagnose',
    'diagnose-metrics',
    'generate',
    'generate-metrics',
    'repair',
    'summarize',
  ])
    await writeFile(join(prompts, `${name}.md`), `Instructions for ${name}.`);
  const manifest = join(resources, 'knowledge/manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 'rsi.operator-knowledge/v1',
      resources: [],
      techniques: [],
      metrics: [],
    }),
  );
  const config = {
    agentRef: 'agent',
    task: { directory: task },
    promptsDirectory: prompts,
    embedding: {
      resourcesDirectory: resources,
      retrievalScript: f.prompt,
      modelDirectory: f.root,
      identityFile: f.prompt,
      python: 'unused',
    },
  };
  const working = f.probe('proposer.operator', config);
  const workingResult = await runDoctor(working);
  assert.deepEqual(
    workingResult.checks.map((check) => check.status),
    ['passed', 'passed', 'unchecked'],
  );
  await rm(join(prompts, 'repair.md'));
  const missingPrompt = f.probe('proposer.operator', config);
  const missingPromptResult = await runDoctor(missingPrompt);
  assert.match(
    missingPromptResult.checks.find(({ id }) => id === 'operator-resources')!
      .reason!,
    /repair.md/,
  );
  assert.equal(missingPromptResult.checks.at(-1)!.status, 'unchecked');
  await writeFile(manifest, '{}');
  const invalidManifest = f.probe('proposer.operator', config);
  const invalidManifestResult = await runDoctor(invalidManifest);
  assert.match(
    invalidManifestResult.checks.find(({ id }) => id === 'operator-resources')!
      .reason!,
    /Invalid external operator knowledge manifest/,
  );
});
