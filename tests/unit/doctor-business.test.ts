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
import type { DoctorContext, JsonObject } from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import type { Registry } from '../../src/runtime/registry/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { checkOptunaDependencies } from '../../src/plugins/proposer-optuna/doctor.js';

async function fixture(t: TestContext): Promise<{
  root: string;
  prompt: string;
  probe(
    id: string,
    config: JsonObject,
  ): Omit<DoctorContext, 'recipe' | 'registry'> & {
    recipe: Recipe;
    registry: Registry;
  };
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
    const workingResult = await working.binding.definition.doctor!(working);
    assert.deepEqual(
      workingResult.checks.map((check) => check.status),
      ['passed', 'passed', 'passed'],
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
    const brokenResult = await broken.binding.definition.doctor!(broken);
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
    assert.equal(
      brokenResult.missingResources?.[0]?.reference,
      join(f.root, 'missing.md'),
    );
    assert.deepEqual(brokenResult.missingResources?.[0]?.checksNotRun, [
      'prepare-project',
    ]);
  });
}

test('editor checks resolve the selected Agent and reject duplicate roles and skills', async (t) => {
  const f = await fixture(t);
  const missingAgent = f.probe('memory.agent', {
    agentRef: 'absent',
    prompt: f.prompt,
  });
  const missingAgentResult =
    await missingAgent.binding.definition.doctor!(missingAgent);
  assert.match(missingAgentResult.checks[0]!.reason!, /agentRef.*absent/);
  assert.equal(missingAgentResult.checks.at(-1)?.status, 'passed');

  const missingGuidance = f.probe('memory.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    guidance: join(f.root, 'missing-guidance'),
  });
  const missingGuidanceResult =
    await missingGuidance.binding.definition.doctor!(missingGuidance);
  assert.equal(
    missingGuidanceResult.missingResources?.[0]?.field,
    'config.guidance',
  );
  assert.equal(missingGuidanceResult.missingResources?.[0]?.kind, 'directory');

  const role = { name: 'reviewer', description: 'Review', prompt: f.prompt };
  const duplicateRoles = f.probe('proposer.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    subagents: [role, role],
  });
  const duplicateRolesResult =
    await duplicateRoles.binding.definition.doctor!(duplicateRoles);
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
  const duplicateSkillsResult =
    await duplicateSkills.binding.definition.doctor!(duplicateSkills);
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
  const workingResult = await working.binding.definition.doctor!(working);
  assert.equal(workingResult.checks[0]!.status, 'passed');
  const broken = f.probe('proposer.grid', {
    path: 'params.json',
    searchSpace: [axis, axis],
  });
  const brokenResult = await broken.binding.definition.doctor!(broken);
  assert.match(brokenResult.checks[0]!.reason!, /duplicate/);
  assert.deepEqual(await broken.runtime.facts.list('candidates'), []);
});

test('selector.metric checks ordinary and prerequisite constraint bounds', async (t) => {
  const f = await fixture(t);
  const working = f.probe('selector.metric', { direction: 'minimize' });
  const workingResult = await working.binding.definition.doctor!(working);
  assert.equal(workingResult.checks[0]!.status, 'passed');
  for (const prerequisite of [false, true]) {
    const broken = f.probe('selector.metric', {
      constraints: [{ metric: 'latency', prerequisite, min: 2, max: 1 }],
    });
    const brokenResult = await broken.binding.definition.doctor!(broken);
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
  const workingResult = await working.binding.definition.doctor!(working);
  assert.deepEqual(
    workingResult.checks.map((check) => check.status),
    ['passed', 'passed'],
  );
  for (const modules of [
    [config.modules[0]!, config.modules[0]!],
    [{ id: 'unsafe', path: '../module.md' }],
  ]) {
    const broken = f.probe('proposer.pareto-evolution', { ...config, modules });
    const brokenResult = await broken.binding.definition.doctor!(broken);
    assert.equal(brokenResult.checks[0]!.status, 'failed');
    assert.equal(brokenResult.checks[1]!.status, 'unchecked');
  }
  const missing = f.probe('proposer.pareto-evolution', {
    ...config,
    modules: [{ id: 'missing', path: 'missing.md' }],
  });
  const missingResult = await missing.binding.definition.doctor!(missing);
  assert.equal(missingResult.checks[1]!.status, 'failed');
  assert.equal(
    missingResult.missingResources?.[0]?.reference,
    join(f.root, 'baseline/missing.md'),
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
  const artifactResult = await artifact.binding.definition.doctor!(artifact);
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
  const workingResult = await checkOptunaDependencies(
    working,
    async (_config, request) => {
      assert.equal(request.action, 'check');
      assert.deepEqual(request.history, []);
      return {
        environment: { python: '3.13.1', optuna: '4.5.0', numpy: '2.2.6' },
      };
    },
  );
  assert.equal(workingResult.checks[0]!.status, 'passed');
  const incompatible = f.probe('proposer.optuna', config);
  const incompatibleResult = await checkOptunaDependencies(
    incompatible,
    async () => ({
      environment: { python: '3.13.1', optuna: '4.4.0', numpy: '2.2.6' },
    }),
  );
  assert.equal(incompatibleResult.checks[0]!.status, 'failed');
  const missing = f.probe('proposer.optuna', {
    ...config,
    python: { executable: join(f.root, 'missing-python') },
  });
  const missingResult = await missing.binding.definition.doctor!(missing);
  assert.equal(missingResult.checks[0]!.status, 'failed');
  assert.match(missingResult.checks[0]!.reason!, /ENOENT/);
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
  const workingResult = await working.binding.definition.doctor!(working);
  assert.deepEqual(
    workingResult.checks.map((check) => check.status),
    ['passed', 'passed', 'passed'],
  );
  await rm(join(prompts, 'repair.md'));
  const missingPrompt = f.probe('proposer.operator', config);
  const missingPromptResult =
    await missingPrompt.binding.definition.doctor!(missingPrompt);
  assert.match(missingPromptResult.checks.at(-1)!.reason!, /repair.md/);
  await writeFile(manifest, '{}');
  const invalidManifest = f.probe('proposer.operator', config);
  const invalidManifestResult =
    await invalidManifest.binding.definition.doctor!(invalidManifest);
  assert.match(
    invalidManifestResult.checks.at(-1)!.reason!,
    /Invalid external operator knowledge manifest/,
  );
});
