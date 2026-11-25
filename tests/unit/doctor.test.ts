import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  access,
  readFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime, type Runtime } from '../../src/runtime/context.js';
import { runCommand as runCliCommand } from '../../src/entries/cli/commands.js';
import { applicationContract } from '../../src/contracts/plugin-types/application.js';
import type { JsonObject } from '../../src/contracts/json.js';
import { doctorRecipe } from '../../src/runtime/doctor/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { waitForProcessExit } from '../helpers/process-exit.js';
import type {
  DoctorReport,
  DoctorRule,
  OperationDoctor,
} from '../../src/contracts/index.js';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';
import { runDoctorProbe } from '../../src/shared/doctor-check.js';
import { object } from '../../src/shared/json.js';

test('doctor probes return data only after successful completion and keep reports free of probe data', async () => {
  const options = { signal: new AbortController().signal };
  const probe = await runDoctorProbe(
    'input',
    async () => ({ content: 'fixture' }),
    options,
  );
  assert.equal(probe.check.status, 'passed');
  assert.deepEqual(probe.value, { content: 'fixture' });
  const failed = await runDoctorProbe(
    'input',
    async () => {
      throw new Error('missing input');
    },
    options,
  );
  assert.equal(failed.check.status, 'failed');
  assert.equal(failed.value, undefined);
  assert.match(failed.check.reason ?? '', /missing input/);
});

async function fixture(): Promise<{
  runtime: Runtime;
  root: string;
  path: string;
  doctors(overrides: Record<string, OperationDoctor>): void;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'doctor-test-'));
  const registry = new Registry();
  const registrations = new Map<string, () => void>();
  const register = registry.registerOperation.bind(registry);
  registry.registerOperation = (definition) => {
    const dispose = register(definition);
    registrations.set(definition.id, dispose);
    return dispose;
  };
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
    registry,
  });
  runtime.registry.registerOperation({
    id: 'test.application',
    contract: applicationContract,
    configSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', 'x-rsi-path': 'file' },
        baseline: {
          type: 'string',
          'x-rsi-path': 'local-directory',
        },
        agentRef: { type: 'string', 'x-rsi-binding': 'contract.agent' },
        conflictingRef: {
          anyOf: [
            { type: 'string', 'x-rsi-binding': 'contract.agent' },
            { type: 'string', 'x-rsi-binding': 'contract.selector-metrics' },
          ],
        },
      },
    },
    async create() {
      return {
        async execute() {
          return assert.fail('doctor cannot run this plugin');
        },
        async dispose() {},
      };
    },
  });
  const policy = join(root, 'policy.yaml');
  await writeFile(
    policy,
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'test.doctor',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        left: { contract: 'contract.selector-metrics' },
        right: { contract: 'contract.selector-metrics' },
      },
      defaults: {
        memory: false,
        reflection: false,
        bindings: {
          left: {
            plugin: 'selector.metric',
            config: { metric: 'score', direction: 'maximize' },
          },
          right: {
            plugin: 'selector.metric',
            config: { metric: 'cost', direction: 'minimize' },
          },
        },
      },
      steps: [],
      output: {},
    }),
  );
  runtime.registry.registerPolicy('test.doctor', policy);
  const path = join(root, 'recipe.yaml');
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-fixture',
      application: { plugin: 'test.application', config: {} },
      policy: { id: 'test.doctor' },
      bindings: { right: { config: { direction: 'maximize' } } },
    }),
  );
  return {
    runtime,
    root,
    path,
    doctors(overrides) {
      for (const [id, doctor] of Object.entries(overrides)) {
        const definition = registry.get(id);
        registrations.get(id)!();
        registry.registerOperation({
          ...definition,
          async create(_config, ctx) {
            ctx.event.on('rsi/doctor', doctor);
            return {
              async execute() {
                return assert.fail('doctor cannot run the policy');
              },
              async dispose() {},
            };
          },
        });
      }
    },
    async dispose() {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function verifyReport(report: DoctorReport): void {
  assert.deepEqual(Object.keys(report).sort(), ['checks', 'recipeId']);
  assert.equal(
    new Set(report.checks.map((check) => check.id)).size,
    report.checks.length,
  );
  for (const check of report.checks) {
    assert.ok(
      Object.keys(check).every((key) =>
        ['id', 'status', 'binding', 'pluginId', 'reason', 'details'].includes(
          key,
        ),
      ),
    );
  }
}

test('an initialization failure belongs to its binding and doctor disposes live peers', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const log: string[] = [];
  const { registry } = f.runtime;
  registry.registerOperation({
    ...registry.get('selector.metric'),
    id: 'selector.probe',
    async create(_config, ctx) {
      log.push('create ' + ctx.bindingId);
      ctx.event.on('rsi/doctor', () => [
        {
          id: 'alive',
          reason: 'Instance must be alive.',
          check: async () => {
            await Promise.resolve();
            assert.ok(!log.includes('dispose ' + ctx.bindingId));
            log.push('doctor ' + ctx.bindingId);
            return true;
          },
        },
      ]);
      if (ctx.bindingId === 'left') throw new Error('dependency unavailable');
      return {
        async execute() {
          return assert.fail('unexpected execution');
        },
        async dispose() {
          await Promise.resolve();
          log.push('dispose ' + ctx.bindingId);
        },
      };
    },
  });
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  recipe.bindings = {
    left: { plugin: 'selector.probe' },
    right: { plugin: 'selector.probe' },
  };
  await writeFile(f.path, JSON.stringify(recipe));
  const full = await doctorRecipe(f.runtime, f.path);
  assert.equal(
    full.checks.filter(({ status }) => status === 'failed').length,
    1,
  );
  assert.match(
    full.checks.find((check) => check.id === 'left.script')?.reason ?? '',
    /dependency unavailable/,
  );
  assert.equal(
    full.checks.find((check) => check.id === 'right.alive')?.status,
    'passed',
  );
  assert.deepEqual(log, [
    'create left',
    'create right',
    'doctor right',
    'dispose right',
  ]);
});

test('a rejected Target path skips the Application factory and still probes other bindings', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const target = join(f.root, 'invalid-target');
  if (process.platform === 'win32') await mkdir(target);
  else await promisify(execFile)('mkfifo', [target]);

  let creations = 0;
  f.runtime.registry.registerOperation({
    ...f.runtime.registry.get('application.agentbundle'),
    id: 'test.file-application',
    async create() {
      creations++;
      throw new Error('Invalid Target reached the factory');
    },
  });
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  recipe.application = {
    plugin: 'test.file-application',
    config: { target: { schema: target }, baseline: { directory: f.root } },
  };
  await writeFile(f.path, JSON.stringify(recipe));
  const report = await doctorRecipe(f.runtime, f.path);
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(creations, 0);
  assert.equal(
    report.checks.filter(({ status }) => status === 'failed').length,
    1,
  );
  assert.equal(
    byId.get('application.resource.target.schema')?.status,
    'failed',
  );
  assert.equal(
    byId.get('application.resource.baseline.directory')?.status,
    'unchecked',
  );
  assert.equal(byId.get('application.plugin')?.status, 'unchecked');
  assert.equal(byId.get('left.configuration')?.status, 'passed');
  assert.equal(byId.get('right.configuration')?.status, 'passed');
  verifyReport(report);
});

test('doctor checks effective per-binding overrides and reports uncovered implementations without experiments', async () => {
  const f = await fixture();
  try {
    const observed: string[] = [];
    const script: OperationDoctor = (ctx) => [
      {
        id: 'effective',
        reason: 'Effective binding configuration must be available.',
        check: () => {
          assert.equal(ctx.binding.pluginId, 'selector.metric');
          observed.push(
            `${ctx.binding.name}:${ctx.binding.config.metric}:${ctx.binding.config.direction}`,
          );
          return true;
        },
      },
    ];
    f.doctors({ 'selector.metric': script });
    const report = await doctorRecipe(f.runtime, f.path);
    assert.deepEqual(observed, ['left:score:maximize', 'right:cost:maximize']);
    assert.ok(report.checks.every(({ status }) => status !== 'failed'));
    assert.match(
      report.checks.find((check) => check.id === 'application.plugin')
        ?.reason ?? '',
      /test.application/,
    );
    assert.deepEqual(await f.runtime.manager.list(), []);
    assert.deepEqual(await readdir(f.root), ['policy.yaml', 'recipe.yaml']);
    verifyReport(report);
  } finally {
    await f.dispose();
  }
});

test('doctor checks declared paths and continues with component diagnostics', async () => {
  const f = await fixture();
  try {
    const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
    object(recipe.application).config = { input: './input.txt' };
    await writeFile(f.path, JSON.stringify(recipe));
    const doctor: OperationDoctor = () => [
      {
        id: 'component',
        check: () => true,
        reason: 'Component must be available.',
      },
    ];
    f.doctors({ 'test.application': doctor, 'selector.metric': doctor });

    const missing = await doctorRecipe(f.runtime, f.path);
    const failure = missing.checks.find(({ status }) => status === 'failed');
    assert.equal(failure?.id, 'application.resource.input');
    assert.ok(failure?.reason?.includes(join(f.root, 'input.txt')));
    assert.match(
      failure?.reason ?? '',
      /Missing file.*Fix:.*application\.config\.input/,
    );
    assert.deepEqual(
      missing.checks
        .filter(({ id }) => id.endsWith('.component'))
        .map(({ id }) => id),
      ['left.component', 'right.component'],
    );
    assert.equal(
      missing.checks.find(({ id }) => id === 'application.plugin')?.status,
      'unchecked',
    );
    verifyReport(missing);

    await writeFile(join(f.root, 'input.txt'), 'fixture');
    const ready = await doctorRecipe(f.runtime, f.path);
    assert.equal(ready.recipeId, 'doctor-fixture');
    assert.ok(ready.checks.every(({ status }) => status !== 'failed'));
    assert.equal(
      ready.checks.find((check) => check.id === 'application.resource.input')
        ?.status,
      'passed',
    );
    verifyReport(ready);
  } finally {
    await f.dispose();
  }
});

test('doctor stops a binding at its first invalid reference and continues other bindings', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.doctors({ 'agent.pi': () => [] });
  const policyPath = join(f.root, 'policy.yaml');
  const policy = object(JSON.parse(await readFile(policyPath, 'utf8')));
  object(policy.require).agent = { contract: 'contract.agent' };
  await writeFile(policyPath, JSON.stringify(policy));

  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  object(recipe.bindings).agent = { plugin: 'agent.pi' };
  const application = object(recipe.application);
  for (const [agentRef, expectedError] of [
    ['agent', null],
    ['left', /agentRef.*left.*contract\.agent/],
    ['missing', /agentRef.*missing.*not declared/],
  ] as const) {
    application.config = { agentRef };
    await writeFile(f.path, JSON.stringify(recipe));
    const report = await doctorRecipe(f.runtime, f.path);
    const check = report.checks.find(
      ({ id }) => id === 'application.binding.agentRef',
    );
    if (expectedError) {
      assert.equal(check?.status, 'failed');
      assert.match(check.reason ?? '', expectedError);
    } else {
      assert.equal(check?.status, 'passed');
    }
    assert.equal(
      report.checks.find(({ id }) => id === 'application.plugin')?.status,
      'unchecked',
    );
    verifyReport(report);
  }
  f.doctors({
    'test.application': () => [
      {
        id: 'independent',
        check: () => true,
        reason: 'Component must be available.',
      },
    ],
  });
  application.config = { agentRef: 'agent', conflictingRef: 'agent' };
  await writeFile(f.path, JSON.stringify(recipe));
  const report = await doctorRecipe(f.runtime, f.path);
  assert.deepEqual(
    report.checks
      .filter(({ status }) => status === 'failed')
      .map(({ id }) => id),
    ['application.binding.conflictingRef'],
  );
  assert.equal(
    report.checks.find(({ id }) => id === 'application.binding.agentRef')
      ?.status,
    'passed',
  );
  assert.match(
    report.checks.find(({ id }) => id === 'application.binding.conflictingRef')
      ?.reason ?? '',
    /conflictingRef.*conflicting binding contracts/,
  );
  assert.equal(
    report.checks.find(({ id }) => id === 'application.independent')?.status,
    undefined,
  );
  verifyReport(report);
});

test('doctor reports the first failed path and stops the binding', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  const baseline = join(f.root, 'baseline');
  await mkdir(baseline);
  const link = join(f.root, 'baseline-link');
  await symlink(baseline, link, 'dir');
  f.doctors({
    'test.application': async () =>
      assert.fail('Invalid paths reached the binding'),
  });
  for (const [config, failedFields] of [
    [{ baseline: link + '/' }, ['baseline']],
    [{ baseline: link + '/.' }, ['baseline']],
    [{ baseline: f.root + '/absent/../baseline' }, ['baseline']],
    [{ baseline: './absent', input: './absent' }, ['input']],
  ] as const) {
    object(recipe.application).config = config;
    await writeFile(f.path, JSON.stringify(recipe));
    const report = await doctorRecipe(f.runtime, f.path);
    const skipped = report.checks.find(({ id }) => id === 'application.plugin');
    assert.equal(skipped?.status, 'unchecked');
    for (const field of failedFields) {
      const id = `application.resource.${field}`;
      const failure = report.checks.find((check) => check.id === id);
      assert.equal(failure?.status, 'failed');
      assert.ok(failure.reason?.includes(`application.config.${field}`));
    }
    assert.equal(
      report.checks.find(({ id }) => id === 'left.configuration')?.status,
      'passed',
    );
    verifyReport(report);
  }
});

test('doctor gates the inference factory on its script and probes the executable when present', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await mkdir(join(f.root, 'baseline'));
  await writeFile(join(f.root, 'baseline', 'tuning.json'), '{}');
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  recipe.application = {
    plugin: 'application.inference',
    config: {
      baseline: { directory: './baseline' },
      target: {
        schema: {
          schemaVersion: 'rsi.target/v1',
          id: 'fixture',
          entries: [
            {
              path: 'tuning.json',
              kind: 'file',
              description: 'Parameters',
              changes: ['modify'],
            },
          ],
        },
      },
      remote: { script: './absent.py', executable: 'must-not-run' },
      endpoint: { model: 'fixture', origin: 'http://localhost:8080' },
    },
  };
  await writeFile(f.path, JSON.stringify(recipe));
  const report = await doctorRecipe(f.runtime, f.path);
  assert.deepEqual(
    report.checks
      .filter(({ status }) => status === 'failed')
      .map(({ id }) => id),
    ['application.resource.remote.script'],
  );
  assert.equal(
    report.checks.find(({ id }) => id === 'application.plugin')?.status,
    'unchecked',
  );
  await writeFile(
    join(f.root, 'absent.py'),
    'raise RuntimeError("must not run")',
  );
  const executable = await doctorRecipe(f.runtime, f.path);
  assert.equal(
    executable.checks.find(({ id }) => id === 'application.remote-executable')
      ?.status,
    'failed',
  );
  assert.equal(
    executable.checks.find(
      ({ id }) => id === 'application.launch-prerequisites',
    )?.status,
    'unchecked',
  );
  verifyReport(executable);
  verifyReport(report);
});

test('doctor and run reject invalid inference URL paths when loading the Recipe', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await mkdir(join(f.root, 'baseline'));
  await writeFile(join(f.root, 'baseline', 'tuning.json'), '{}');
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  const common = {
    baseline: { directory: './baseline' },
    target: {
      schema: {
        schemaVersion: 'rsi.target/v1',
        id: 'fixture',
        entries: [
          {
            path: 'tuning.json',
            kind: 'file',
            description: 'Parameters',
            changes: ['modify'],
          },
        ],
      },
    },
  };
  const local = {
    ...common,
    start: { argv: [process.execPath] },
    endpoint: { model: 'fixture' },
  };
  const remote = {
    ...common,
    remote: { script: './controller.py' },
    endpoint: { model: 'fixture', origin: 'http://localhost:8080' },
  };
  for (const [base, healthcheck, basePath, field] of [
    [local, 'health', '/v1', /healthcheck\/path/],
    [local, '/health', '//v1', /endpoint\/basePath/],
    [remote, '/health?ready=true', '/v1', /healthcheck\/path/],
    [remote, '/health', '/v1#fragment', /endpoint\/basePath/],
  ] as const) {
    recipe.application = {
      plugin: 'application.inference',
      config: {
        ...base,
        healthcheck: { path: healthcheck },
        endpoint: { ...base.endpoint, basePath },
      },
    };
    await writeFile(f.path, JSON.stringify(recipe));
    const report = await doctorRecipe(f.runtime, f.path);
    assert.deepEqual(
      report.checks.map(({ id, status }) => [id, status]),
      [['recipe.validate', 'failed']],
    );
    assert.match(report.checks[0]?.reason ?? '', field);
    await assert.rejects(
      runCliCommand(['run', f.path], {
        openRuntime: async () => f.runtime,
        releaseRuntime: () => f.runtime.dispose(),
        signal: new AbortController().signal,
      }),
      field,
    );
  }

  recipe.application = {
    plugin: 'application.inference',
    config: {
      ...local,
      healthcheck: { path: '/health?ready=true' },
      endpoint: { model: 'fixture', basePath: '/v1#fragment' },
    },
  };
  await writeFile(f.path, JSON.stringify(recipe));
  const report = await doctorRecipe(f.runtime, f.path);
  assert.equal(
    report.checks.find(({ id }) => id === 'application.launch-prerequisites')
      ?.status,
    'passed',
  );
});

test('agent editor doctor uses declared path failures and still checks skill contents', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.doctors({ 'agent.pi': () => [] });
  await writeFile(join(f.root, 'prompt.md'), 'Instructions.');
  await mkdir(join(f.root, 'skill'));
  const policyPath = join(f.root, 'policy.yaml');
  const policy = object(JSON.parse(await readFile(policyPath, 'utf8')));
  object(policy.require).agent = { contract: 'contract.agent' };
  object(policy.require).editor = { contract: 'contract.proposer' };
  await writeFile(policyPath, JSON.stringify(policy));
  const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
  const bindings = object(recipe.bindings);
  bindings.agent = { plugin: 'agent.pi' };
  const cases: [JsonObject, string][] = [
    [{ prompt: './skill' }, 'resource.prompt'],
    [{ guidance: './prompt.md' }, 'resource.guidance'],
    [{ skills: ['./missing-skill'] }, 'resource.skills.0'],
    [
      {
        subagents: [
          { name: 'reviewer', description: 'Review', prompt: './skill' },
        ],
      },
      'resource.subagents.0.prompt',
    ],
    [{ skills: ['./skill'] }, 'editing-inputs'],
  ];
  for (const [overrides, failedId] of cases) {
    bindings.editor = {
      plugin: 'proposer.agent',
      config: { prompt: './prompt.md', agentRef: 'agent', ...overrides },
    };
    await writeFile(f.path, JSON.stringify(recipe));
    const report = await doctorRecipe(f.runtime, f.path);
    const checks = new Map(report.checks.map((check) => [check.id, check]));
    const blocker = `editor.${failedId}`;
    assert.deepEqual(
      report.checks
        .filter(({ status }) => status === 'failed')
        .map(({ id }) => id),
      [blocker],
    );
    assert.equal(
      checks.get('editor.binding.agentRef')?.status,
      failedId === 'editing-inputs' ? 'passed' : 'unchecked',
    );
    if (failedId === 'editing-inputs') {
      assert.equal(checks.get('editor.prepare-project')?.status, 'unchecked');
      assert.ok(
        checks
          .get(blocker)
          ?.reason?.includes(join(f.root, 'skill', 'SKILL.md')),
      );
    } else {
      assert.equal(checks.get('editor.plugin')?.status, 'unchecked');
    }
    verifyReport(report);
  }
});

test('doctor retains Recipe schema, Policy, binding, budget and Reflection validation before probes', async () => {
  const f = await fixture();
  try {
    const original = object(JSON.parse(await readFile(f.path, 'utf8')));
    const policyPath = join(f.root, 'policy.yaml');
    const policy = object(JSON.parse(await readFile(policyPath, 'utf8')));
    policy.config_schema = {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1 } },
    };
    await writeFile(policyPath, JSON.stringify(policy));
    const invalid: {
      name: string;
      change(recipe: JsonObject): void;
      reason: RegExp;
    }[] = [
      {
        name: 'Recipe schema',
        change(recipe) {
          delete recipe.id;
        },
        reason: /recipe/,
      },
      {
        name: 'Policy registration',
        change(recipe) {
          object(recipe.policy).id = 'missing.policy';
        },
        reason: /missing.policy/,
      },
      {
        name: 'Policy configuration',
        change(recipe) {
          object(recipe.policy).config = { limit: 0 };
        },
        reason: /recipe.policy.config/,
      },
      {
        name: 'undeclared binding',
        change(recipe) {
          object(recipe.bindings).extra = {
            plugin: 'selector.metric',
            config: {},
          };
        },
        reason: /Binding extra/,
      },
      {
        name: 'binding contract',
        change(recipe) {
          object(object(recipe.bindings).right).plugin = 'agent.pi';
        },
        reason: /Binding right/,
      },
      {
        name: 'binding configuration',
        change(recipe) {
          object(object(object(recipe.bindings).right).config).direction =
            'sideways';
        },
        reason: /Binding right/,
      },
      {
        name: 'Application contract',
        change(recipe) {
          object(recipe.application).plugin = 'selector.metric';
        },
        reason: /Binding application/,
      },
      {
        name: 'budget',
        change(recipe) {
          recipe.budget = { operations: -1 };
        },
        reason: /budget.*operations/,
      },
      {
        name: 'unknown Reflection field',
        change(recipe) {
          recipe.reflection = { configFile: 'missing.yaml' };
        },
        reason: /reflection|configFile/i,
      },
    ];
    let probes = 0;
    const script: OperationDoctor = () => [
      {
        id: 'probe',
        reason: 'Probe must be reachable.',
        check: () => {
          probes++;
          return true;
        },
      },
    ];
    for (const scenario of invalid) {
      const data = structuredClone(original);
      scenario.change(data);
      await writeFile(f.path, JSON.stringify(data));
      f.doctors({
        'test.application': script,
        'selector.metric': script,
      });
      const report = await doctorRecipe(f.runtime, f.path);
      assert.equal(report.recipeId, null, scenario.name);
      assert.deepEqual(
        report.checks.map(({ id, status }) => [id, status]),
        [['recipe.validate', 'failed']],
        scenario.name,
      );
      assert.match(
        report.checks[0].reason ?? '',
        scenario.reason,
        scenario.name,
      );
      verifyReport(report);
    }
    assert.equal(probes, 0);
    assert.deepEqual(await f.runtime.manager.list(), []);
  } finally {
    await f.dispose();
  }
});

test('probe errors and deadlines preserve independent results, redact secrets and clean owned storage', async () => {
  const f = await fixture();
  const secret = 'doctor-test-secret-value';
  const previous = process.env.DOCTOR_TEST_API_KEY;
  const previousOrdinary = process.env.DOCTOR_VALUE;
  process.env.DOCTOR_TEST_API_KEY = secret;
  process.env.DOCTOR_VALUE = 'credential-with-ordinary-variable-name';
  let probeDirectory = '';
  let released = 0;
  try {
    const declaration = object(JSON.parse(await readFile(f.path, 'utf8')));
    object(object(declaration.application).config).api_key = '${DOCTOR_VALUE}';
    await writeFile(f.path, JSON.stringify(declaration));
    f.doctors({
      'test.application': (ctx): DoctorRule[] => [
        {
          id: 'scope',
          reason: 'This fixture does not probe credentials.',
          details: { availableBytes: 4096, unknown: null, credential: secret },
        },
        {
          id: 'throws',
          reason: 'Restore the input.',
          details: {
            availableBytes: 4096,
            requiredBytes: null,
            nested: [{ credential: process.env.DOCTOR_VALUE ?? '' }],
          },
          check: async () => {
            probeDirectory = ctx.directory;
            await writeFile(join(ctx.directory, 'owned'), 'temporary');
            throw new Error(`${secret} ${process.env.DOCTOR_VALUE}`);
          },
        },
        {
          id: 'depends-on-throw',
          reason: 'Restore the prerequisite.',
          check: () =>
            assert.fail('A failed prerequisite must stop later steps.'),
        },
      ],
      'selector.metric': ({ binding }) =>
        binding.name === 'left'
          ? [
              {
                id: 'timeout',
                reason: 'Restore the timed out service.',
                timeoutMs: 10,
                check: async (signal) => {
                  try {
                    await new Promise<void>((_done, reject) =>
                      signal.addEventListener(
                        'abort',
                        () => reject(signal.reason),
                        { once: true },
                      ),
                    );
                    return true;
                  } finally {
                    released++;
                  }
                },
              },
              {
                id: 'depends-on-timeout',
                reason: 'Restore the prerequisite.',
                check: () =>
                  assert.fail(
                    'A timed out prerequisite must stop later steps.',
                  ),
              },
            ]
          : [
              {
                id: 'independent',
                check: () => true,
                reason: 'Component must be available.',
              },
            ],
    });
    const report = await doctorRecipe(f.runtime, f.path);
    assert.equal(
      report.checks.filter(({ status }) => status === 'failed').length,
      2,
    );
    assert.equal(released, 1);
    assert.equal(
      report.checks.find((check) => check.id === 'application.depends-on-throw')
        ?.status,
      'unchecked',
    );
    assert.equal(
      report.checks.find((check) => check.id === 'left.depends-on-timeout')
        ?.status,
      'unchecked',
    );
    assert.match(
      report.checks.find((check) => check.id === 'left.timeout')?.reason ?? '',
      /timed out.*availability is unknown/,
    );
    assert.ok(
      report.checks.some(
        (check) =>
          check.id === 'right.independent' && check.status === 'passed',
      ),
    );
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(process.env.DOCTOR_VALUE));
    assert.equal(
      report.checks.find((check) => check.id === 'application.throws')?.details
        ?.availableBytes,
      4096,
    );
    assert.equal(
      report.checks.find((check) => check.id === 'application.scope')?.details
        ?.unknown,
      null,
    );
    await assert.rejects(access(probeDirectory));
    assert.deepEqual(await f.runtime.manager.list(), []);
    verifyReport(report);
  } finally {
    if (previous === undefined) delete process.env.DOCTOR_TEST_API_KEY;
    else process.env.DOCTOR_TEST_API_KEY = previous;
    if (previousOrdinary === undefined) delete process.env.DOCTOR_VALUE;
    else process.env.DOCTOR_VALUE = previousOrdinary;
    await f.dispose();
  }
});

test('interruption cancels an owned subprocess, cleans storage and stops dispatch', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let probeDirectory = '';
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let independent = false;
  try {
    f.doctors({
      'test.application': (ctx): DoctorRule[] => [
        {
          id: 'process',
          reason: 'The subprocess must finish.',
          check: async (signal) => {
            probeDirectory = ctx.directory;
            const pending = runCommand(
              process.execPath,
              ['-e', 'setInterval(()=>{},1000)'],
              { signal },
            );
            entered();
            await pending;
            return true;
          },
        },
      ],
      'selector.metric': () => [
        {
          id: 'independent',
          reason: 'Component must be available.',
          check: () => {
            independent = true;
            return true;
          },
        },
      ],
    });
    const result = doctorRecipe(f.runtime, f.path, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('test interruption'));
    await assert.rejects(result, /test interruption/);
    assert.equal(independent, false);
    await assert.rejects(access(probeDirectory));
    assert.deepEqual(await f.runtime.manager.list(), []);
  } finally {
    await f.dispose();
  }
});

test('doctor reads original artifacts and keeps probe writes in temporary storage', async () => {
  const f = await fixture();
  try {
    const artifacts = f.runtime.context.artifacts;
    const original = await artifacts.putJson({ source: 'original' });
    const input = join(f.root, 'input');
    await mkdir(input);
    await writeFile(join(input, 'seed.txt'), 'original file');
    const files = await artifacts.capture(input);
    f.doctors({
      'test.application': ({ runtime, directory }) => [
        {
          id: 'artifacts',
          reason: 'Artifact reads and writes must remain isolated.',
          details: { directory },
          check: async () => {
            assert.deepEqual(await runtime.artifacts.readJson(original), {
              source: 'original',
            });
            const copy = join(directory, 'copy');
            await runtime.artifacts.materialize(files, copy);
            assert.equal(
              await readFile(join(copy, 'seed.txt'), 'utf8'),
              'original file',
            );
            await writeFile(join(copy, 'seed.txt'), 'probe file');
            const captured = await runtime.artifacts.capture(copy);
            const written = await runtime.artifacts.putJson({
              source: 'probe',
            });
            assert.deepEqual(await runtime.artifacts.readJson(written), {
              source: 'probe',
            });
            await assert.rejects(artifacts.readJson(captured), {
              code: 'ENOENT',
            });
            await assert.rejects(artifacts.readJson(written), {
              code: 'ENOENT',
            });
            return true;
          },
        },
      ],
    });
    const report = await doctorRecipe(f.runtime, f.path);
    const check = report.checks.find(
      ({ id }) => id === 'application.artifacts',
    );
    assert.equal(check?.status, 'passed', JSON.stringify(report));
    await assert.rejects(access(String(check?.details?.directory)), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(input, 'seed.txt'), 'utf8'),
      'original file',
    );
  } finally {
    await f.dispose();
  }
});

test('doctor aggregates complete valid results and isolates callback errors by binding', async () => {
  const f = await fixture();
  try {
    f.doctors({
      'test.application': async () => {
        throw new Error('Unexpected callback error');
      },
      'selector.metric': ({ binding }) => [
        {
          id: 'input',
          check: () => false,
          reason: 'Missing file missing.txt. Restore it or correct input.',
        },
        {
          id: binding.name === 'left' ? 'input' : 'dependent',
          check: () =>
            assert.fail('A failed prerequisite must stop later steps.'),
          reason: 'Restore the prerequisite input.',
        },
      ],
    });
    const report = await doctorRecipe(f.runtime, f.path);
    assert.deepEqual(
      report.checks.map(({ id, status }) => [id, status]),
      [
        ['recipe.validate', 'passed'],
        ['memory.status', 'unchecked'],
        ['reflection.status', 'unchecked'],
        ['application.script', 'failed'],
        ['left.script', 'failed'],
        ['right.input', 'failed'],
        ['right.dependent', 'unchecked'],
      ],
    );
    assert.match(
      report.checks.find(({ id }) => id === 'application.script')?.reason ?? '',
      /Unexpected callback error/,
    );
    assert.match(
      report.checks.find(({ id }) => id === 'left.script')?.reason ?? '',
      /nonempty and unique/,
    );
    assert.match(
      report.checks.find(({ id }) => id === 'right.input')?.reason ?? '',
      /Missing file missing.txt/,
    );
    assert.match(
      report.checks.find(({ id }) => id === 'right.dependent')?.reason ?? '',
      /input failed/,
    );
    verifyReport(report);
  } finally {
    await f.dispose();
  }
});

test('an aborted process probe closes its descendant process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-process-tree-'));
  const controller = new AbortController();
  const marker = join(root, 'child-pid');
  const job = runCommand(
    process.execPath,
    [
      '-e',
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);",
      marker,
    ],
    { signal: controller.signal },
  );
  // Attach rejection handling before aborting to avoid a transient unhandled rejection.
  const outcome = job.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    let descendant = 0;
    const deadline = Date.now() + 10000;
    while (!descendant && Date.now() < deadline) {
      descendant = Number(await readFile(marker, 'utf8').catch(() => '0'));
      if (!descendant) await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(descendant > 0, 'probe spawned its owned descendant');
    controller.abort(new Error('process-tree-test-abort'));
    assert.match(String(await outcome), /process-tree-test-abort/);
    await waitForProcessExit(descendant);
  } finally {
    controller.abort(new Error('test cleanup'));
    await outcome;
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout diagnostics retain a probe cleanup failure and continue independent checks', async () => {
  const f = await fixture();
  try {
    f.doctors({
      'test.application': () => [
        {
          id: 'cleanup-error',
          reason: 'The probe must clean up.',
          timeoutMs: 10,
          check: async (signal) => {
            try {
              await new Promise<void>((_done, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                }),
              );
              return true;
            } finally {
              throw new Error('cleanup-fixture-failed');
            }
          },
        },
      ],
      'selector.metric': () => [
        {
          id: 'independent',
          check: () => true,
          reason: 'Component must be available.',
        },
      ],
    });
    const report = await doctorRecipe(f.runtime, f.path);
    assert.match(
      report.checks.find((check) => check.id === 'application.cleanup-error')
        ?.reason ?? '',
      /timed out.*cleanup-fixture-failed/,
    );
    assert.equal(
      report.checks.find((check) => check.id === 'right.independent')?.status,
      'passed',
    );
    verifyReport(report);
  } finally {
    await f.dispose();
  }
});

test('CLI doctor explains missing files, blocked work and network fixes in its default summary', async () => {
  const f = await fixture();
  try {
    const recipe = object(JSON.parse(await readFile(f.path, 'utf8')));
    object(recipe.application).config = { input: './input.txt' };
    await writeFile(f.path, JSON.stringify(recipe));
    f.doctors({
      'selector.metric': ({ binding }) =>
        binding.name === 'left'
          ? [
              {
                id: 'sdk.network',
                check: () => false,
                reason: 'Network probes failed.\u001b[2J',
                details: {
                  probes: [
                    {
                      name: 'Dataset download',
                      status: 'failed',
                      evidence: 'Connection timed out',
                      guidance: {
                        action: 'Configure the download proxy.',
                        yamlFields: ['network.proxy'],
                      },
                    },
                  ],
                },
              },
            ]
          : [
              {
                id: 'ready',
                check: () => true,
                reason: 'Component must be ready.',
              },
            ],
    });
    const result = await runCliCommand(['doctor', f.path], {
      signal: new AbortController().signal,
      openRuntime: async () => f.runtime,
      releaseRuntime: async () => {},
    });
    assert.equal(result.exitCode, 1);
    const summary = result.stdout ?? '';
    assert.match(summary, /Doctor found failures.*doctor-fixture/);
    assert.match(summary, /2 failed/);
    assert.match(summary, /application\.resource\.input/);
    assert.ok(summary.includes(join(f.root, 'input.txt')));
    assert.match(summary, /Fix:.*application\.config\.input/);
    assert.match(
      summary,
      /Subsequent checks for this plugin were not completed/,
    );
    assert.match(summary, /Dataset download.*Connection timed out/);
    assert.match(summary, /Configure the download proxy/);
    assert.match(summary, /network\.proxy/);
    assert.doesNotMatch(summary, /right\.ready|\u001b/u);
  } finally {
    await f.dispose();
  }
});

test('CLI doctor emits one JSON diagnostic with --json and reports usage separately', async () => {
  const f = await fixture();
  const execute = promisify(execFile);
  const run = async (
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', resolve('src/entries/cli/main.ts'), ...args],
        { cwd: process.cwd(), timeout: 30000, env },
      );
      return { code: 0, ...result };
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'stdout' in error &&
          'stderr' in error &&
          'code' in error
        )
      )
        throw error;
      return {
        code: Number(error.code),
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    }
  };
  try {
    const broken = join(f.root, 'broken-extension');
    await mkdir(broken);
    await writeFile(
      join(broken, 'index.mjs'),
      "export function register(){throw new Error('broken-extension-fixture');}\n",
    );
    const registered = await run([
      'doctor',
      f.path,
      '--json',
      '--plugin-dir',
      broken,
    ]);
    assert.equal(registered.code, 1);
    assert.equal(registered.stderr, '');
    const report: DoctorReport = JSON.parse(registered.stdout);
    verifyReport(report);
    assert.equal(report.recipeId, null);
    assert.equal(report.checks[0].id, 'runtime.registration');
    const loaded = await run(['doctor', join(f.root, 'absent.yaml'), '--json']);
    assert.equal(loaded.code, 1);
    assert.equal(JSON.parse(loaded.stdout).checks[0].id, 'recipe.validate');
    assert.equal(loaded.stderr, '');
    const usage = await run(['doctor']);
    assert.equal(usage.code, 2);
    assert.equal(usage.stdout, '');
    const removed = await run(['validate', f.path]);
    assert.equal(removed.code, 2);
    assert.equal(removed.stdout, '');
    assert.match(removed.stderr, /unknown command 'validate'/);
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /doctor/);
    assert.doesNotMatch(help.stdout, /\bvalidate\b/);
    const doctorHome = join(f.root, 'doctor-home');
    const secret = 'doctor-summary-secret-fixture';
    const fresh = await run(['doctor', join(f.root, `absent-${secret}.yaml`)], {
      ...process.env,
      HOME: doctorHome,
      USERPROFILE: doctorHome,
      DOCTOR_TEST_API_KEY: secret,
    });
    assert.equal(fresh.code, 1);
    assert.match(
      fresh.stdout,
      /Doctor found failures.*absent-\[redacted\]\.yaml/,
    );
    assert.match(fresh.stdout, /recipe\.validate.*ENOENT/);
    assert.match(fresh.stdout, /Fix:/);
    assert.ok(!fresh.stdout.includes(secret));
    await assert.rejects(access(join(doctorHome, '.arsi')));
  } finally {
    await f.dispose();
  }
});

test('disabled evolution modules report their status without accessing unused resources', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const data = object(JSON.parse(await readFile(f.path, 'utf8')));
  for (const name of ['memory', 'reflection']) data[name] = false;
  await writeFile(f.path, JSON.stringify(data));
  const report = await doctorRecipe(f.runtime, f.path);
  assert.ok(report.checks.every(({ status }) => status !== 'failed'));
  for (const name of ['memory', 'reflection'])
    assert.deepEqual(
      report.checks
        .filter((check) => check.id.startsWith(name + '.'))
        .map((check) => [check.id, check.status]),
      [[name + '.status', 'unchecked']],
    );
});
