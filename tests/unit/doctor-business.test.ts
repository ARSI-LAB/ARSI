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
import type { JsonObject } from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import type { Registry } from '../../src/runtime/registry/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { checkOptunaDependencies } from '../../src/runtime/doctor/business-checks.js';
import type {
  DoctorCheck,
  DoctorContext,
  MissingResource,
} from '../../src/contracts/index.js';

async function fixture(t: TestContext): Promise<{
  root: string;
  prompt: string;
  probe(
    id: string,
    config: JsonObject,
  ): Omit<DoctorContext, 'recipe' | 'registry'> & {
    recipe: Recipe;
    registry: Registry;
    checks: DoctorCheck[];
    missingResources: MissingResource[];
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
      const checks: DoctorCheck[] = [];
      const missingResources: MissingResource[] = [];
      return {
        checks,
        missingResources,
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
        async check(checkId, action) {
          try {
            await action(signal);
            checks.push({ id: checkId, status: 'passed' });
            return true;
          } catch (error) {
            checks.push({
              id: checkId,
              status: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        },
        unchecked(checkId, reason) {
          checks.push({ id: checkId, status: 'unchecked', reason });
        },
        missing(resource) {
          missingResources.push({
            binding: 'probe',
            pluginId: id,
            ...resource,
          });
        },
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
    await working.binding.definition.doctor!(working);
    assert.deepEqual(
      working.checks.map((check) => check.status),
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
    await broken.binding.definition.doctor!(broken);
    assert.equal(
      broken.checks.find((check) => check.id === 'editing-inputs')?.status,
      'failed',
    );
    assert.equal(
      broken.checks.find((check) => check.id === 'prepare-project')?.status,
      'unchecked',
    );
    assert.equal(
      broken.missingResources[0]?.reference,
      join(f.root, 'missing.md'),
    );
    assert.deepEqual(broken.missingResources[0]?.checksNotRun, [
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
  await missingAgent.binding.definition.doctor!(missingAgent);
  assert.match(missingAgent.checks[0]!.reason!, /agentRef.*absent/);
  assert.equal(missingAgent.checks.at(-1)?.status, 'passed');

  const missingGuidance = f.probe('memory.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    guidance: join(f.root, 'missing-guidance'),
  });
  await missingGuidance.binding.definition.doctor!(missingGuidance);
  assert.equal(missingGuidance.missingResources[0]?.field, 'config.guidance');
  assert.equal(missingGuidance.missingResources[0]?.kind, 'directory');

  const role = { name: 'reviewer', description: 'Review', prompt: f.prompt };
  const duplicateRoles = f.probe('proposer.agent', {
    agentRef: 'agent',
    prompt: f.prompt,
    subagents: [role, role],
  });
  await duplicateRoles.binding.definition.doctor!(duplicateRoles);
  assert.match(duplicateRoles.checks.at(-1)!.reason!, /duplicate agent role/);

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
  await duplicateSkills.binding.definition.doctor!(duplicateSkills);
  assert.match(duplicateSkills.checks.at(-1)!.reason!, /Duplicate skill name/);
});

test('proposer.grid constructs a valid grid and rejects repeated axes', async (t) => {
  const f = await fixture(t);
  const axis = { name: 'size', values: [1, 2] };
  const working = f.probe('proposer.grid', {
    path: 'params.json',
    searchSpace: [axis],
  });
  await working.binding.definition.doctor!(working);
  assert.equal(working.checks[0]!.status, 'passed');
  const broken = f.probe('proposer.grid', {
    path: 'params.json',
    searchSpace: [axis, axis],
  });
  await broken.binding.definition.doctor!(broken);
  assert.match(broken.checks[0]!.reason!, /duplicate/);
  assert.deepEqual(await broken.runtime.facts.list('candidates'), []);
});

test('selector.metric constructs a valid selector and checks both bound collections', async (t) => {
  const f = await fixture(t);
  const working = f.probe('selector.metric', { direction: 'minimize' });
  await working.binding.definition.doctor!(working);
  assert.equal(working.checks[0]!.status, 'passed');
  for (const field of ['eligibility', 'constraints']) {
    const broken = f.probe('selector.metric', {
      [field]: [{ metric: 'latency', min: 2, max: 1 }],
    });
    await broken.binding.definition.doctor!(broken);
    assert.match(broken.checks[0]!.reason!, /min exceeds max/);
  }
});

test('search.prompt-evolution checks module identities and the real baseline files', async (t) => {
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
  const working = f.probe('search.prompt-evolution', config);
  await working.binding.definition.doctor!(working);
  assert.deepEqual(
    working.checks.map((check) => check.status),
    ['passed', 'passed'],
  );
  for (const modules of [
    [config.modules[0]!, config.modules[0]!],
    [{ id: 'unsafe', path: '../module.md' }],
  ]) {
    const broken = f.probe('search.prompt-evolution', { ...config, modules });
    await broken.binding.definition.doctor!(broken);
    assert.equal(broken.checks[0]!.status, 'failed');
    assert.equal(broken.checks[1]!.status, 'unchecked');
  }
  const missing = f.probe('search.prompt-evolution', {
    ...config,
    modules: [{ id: 'missing', path: 'missing.md' }],
  });
  await missing.binding.definition.doctor!(missing);
  assert.equal(missing.checks[1]!.status, 'failed');
  assert.equal(
    missing.missingResources[0]?.reference,
    join(f.root, 'baseline/missing.md'),
  );

  const artifact = f.probe('search.prompt-evolution', config);
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
  await artifact.binding.definition.doctor!(artifact);
  assert.deepEqual(
    artifact.checks.map((check) => check.status),
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
  await checkOptunaDependencies(working, async (_config, request) => {
    assert.equal(request.action, 'check');
    assert.deepEqual(request.history, []);
    return {
      environment: { python: '3.13.1', optuna: '4.5.0', numpy: '2.2.6' },
    };
  });
  assert.equal(working.checks[0]!.status, 'passed');
  const incompatible = f.probe('proposer.optuna', config);
  await checkOptunaDependencies(incompatible, async () => ({
    environment: { python: '3.13.1', optuna: '4.4.0', numpy: '2.2.6' },
  }));
  assert.equal(incompatible.checks[0]!.status, 'failed');
  const missing = f.probe('proposer.optuna', {
    ...config,
    python: { executable: join(f.root, 'missing-python') },
  });
  await missing.binding.definition.doctor!(missing);
  assert.equal(missing.checks[0]!.status, 'failed');
  assert.match(missing.checks[0]!.reason!, /ENOENT/);
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
  await working.binding.definition.doctor!(working);
  assert.deepEqual(
    working.checks.map((check) => check.status),
    ['passed', 'passed', 'passed'],
  );
  await rm(join(prompts, 'repair.md'));
  const missingPrompt = f.probe('proposer.operator', config);
  await missingPrompt.binding.definition.doctor!(missingPrompt);
  assert.match(missingPrompt.checks.at(-1)!.reason!, /repair.md/);
  await writeFile(manifest, '{}');
  const invalidManifest = f.probe('proposer.operator', config);
  await invalidManifest.binding.definition.doctor!(invalidManifest);
  assert.match(
    invalidManifest.checks.at(-1)!.reason!,
    /Invalid external operator knowledge manifest/,
  );
});
