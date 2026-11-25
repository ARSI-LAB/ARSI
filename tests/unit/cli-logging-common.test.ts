import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { getLogger } from '@logtape/logtape';
import {
  Evaluator,
  type EvaluatorRunOptions,
  type ProgressEvent,
} from 'arsi-evaluator';
import {
  agentContract,
  memoryContract,
  RuntimeContext,
  type AgentObservation,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { metricSelectorContract } from '../../src/contracts/plugin-types/selector-metrics.js';
import {
  runCommand,
  type CommandOptions,
} from '../../src/entries/cli/commands.js';
import { formatErrorStack } from '../../src/entries/cli/log-text.js';
import {
  cliLogger,
  configureCliLogging,
  formatCargoLine,
  parseLogLevels,
  runtimeLogger,
  type CliLogging,
  type RunningTask,
} from '../../src/entries/cli/logging.js';
import {
  createResumeReport,
  reportRunSummary,
} from '../../src/entries/cli/run-report.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
import { sdkRunner } from '../../src/plugins/shared/evaluator-adapter/sdk.js';
import { object } from '../../src/shared/json.js';
import { reportTaskProgress } from '../../src/shared/task-progress.js';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';

const envKeys = ['ARSI_LOG_LEVEL', 'ARSI_LOG_LEVELS', 'ARSI_LOG_TEST_TOKEN'];
const originalEnvironment = envKeys.map(
  (key) => [key, process.env[key]] as const,
);
test.beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
});
test.afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixtureCommand(
  fixture: Awaited<ReturnType<typeof managerFixture>>,
  logging: CliLogging,
  defaults?: CommandOptions,
) {
  const { manager } = fixture;
  const workspace = manager.rootDirectory;
  return (...argv: string[]) =>
    runCommand(argv, {
      signal: new AbortController().signal,
      defaults,
      openRuntime: async () => ({
        manager,
        context: manager.context,
        registry: manager.options.registry,
        dispose: () => manager.dispose(),
      }),
      releaseRuntime: () => manager.dispose(),
      dispatch: (command, options, execute, experimentId) =>
        logging.run(options, execute, { command, experimentId, workspace }),
    });
}

async function temporaryWorkspace(t: TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'arsi-log-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test('generated experiment IDs route the whole invocation to their own log', async (t) => {
  const plugin = getLogger(['arsi', 'plugin', 'fixture']);
  const fixture = await managerFixture(async () => {
    await Promise.resolve();
    plugin.debug('Plugin detail');
    return {};
  });
  t.after(() => fixture.dispose());
  const workspace = fixture.manager.rootDirectory;
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  const result = await fixtureCommand(fixture, logging)(
    'run',
    join(workspace, 'recipe.yaml'),
  );
  assert.equal(result.exitCode, 0);
  const { id, status } = JSON.parse(result.stdout ?? '');
  assert.match(id, /^test-[a-f0-9]{8}$/);
  assert.equal(status, 'succeeded');
  const progress = terminal.join('');
  assert.match(progress, /^ {2}Starting /m);
  assert.match(progress, /Preparing test-[a-f0-9]{8} \(policy test\.policy\)/);
  assert.match(progress, /Completed initialize .*candidate candidate-/);
  assert.match(progress, /Completed driver \(drive\)/);
  assert.equal(progress.match(/^\s*Finished /gm)?.length, 1);
  assert.match(
    progress,
    /Finished .* succeeded in [\s\S]*Usage operations=2[\s\S]*Log \.rsi\/logs\/test-/,
  );
  assert.doesNotMatch(progress, /Plugin detail|Running driver|Opening runtime/);

  const directory = join(workspace, '.rsi', 'logs');
  assert.deepEqual(await readdir(directory), [`${id}.log`]);
  const saved = await readFile(join(directory, `${id}.log`), 'utf8');
  const context = `[${id}]`;
  assert.match(saved, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}  INFO /);
  assert.ok(saved.includes(`${context} arsi.cli             : Starting`));
  assert.ok(saved.includes(`${context} arsi.plugin.fixture  : Plugin detail`));
  assert.doesNotMatch(saved, /arsi\.cli\s+: Log /);
});

test('Cargo restores saved task scores, handles a receipt ahead of its checkpoint, and summarizes the run', async (t) => {
  const candidateRef = 'candidate-' + 'a'.repeat(32);
  let evaluations = 0;
  let memories = 0;
  const fixture = await managerFixture(
    async (context) => {
      const score = [0, 0.25, 0.75, 0.5][evaluations++]!;
      const measurement = await measurementFixture(context);
      measurement.candidateRef = candidateRef;
      const metrics = object(measurement.metrics);
      object(object(metrics.score).value).value = score;
      const list = object(
        await context.artifacts.readJson(String(measurement.itemsRef)),
      );
      assert.ok(Array.isArray(list.items));
      object(list.items[0]).metrics = metrics;
      measurement.itemsRef = await context.artifacts.putJson(list);
      return {
        candidateRef,
        measurementRef: await context.recordMeasurement(measurement),
      };
    },
    {
      plugins: [
        {
          id: 'test.memory',
          contract: memoryContract,
          configSchema: { type: 'object' },
          async create() {
            return {
              async execute() {
                memories++;
                return {
                  status: 'failed',
                  memoryRef: null,
                  changeRef: null,
                  reason: 'Optional update failed',
                };
              },
              async dispose() {},
            };
          },
        },
        {
          id: 'test.selector',
          contract: metricSelectorContract,
          configSchema: { type: 'object' },
          async create() {
            return {
              async execute(input) {
                return {
                  accepted: true,
                  candidateFeasible: true,
                  selectedCandidateRef: candidateRef,
                  reason: 'Improved',
                  decisionRef: 'decision-fixture',
                  measurementRef: object(input).candidateMeasurementRef!,
                  metric: 'score',
                  incumbentValue: 0,
                  candidateValue: 0.75,
                  selectedValue: 0.75,
                };
              },
              async dispose() {},
            };
          },
        },
      ],
      bindings: {
        memoryUpdater: { plugin: 'test.memory', config: {} },
        selector: { plugin: 'test.selector', config: {} },
      },
      policy: {
        state_schema: {
          type: 'object',
          properties: { selected: { type: ['object', 'null'] } },
        },
        state: { selected: null },
        steps: [
          { id: 'baseline', type: 'invoke', use: 'driver', with: {} },
          {
            id: 'search',
            type: 'loop',
            maxIterations: 1,
            steps: [
              { id: 'train', type: 'invoke', use: 'driver', with: {} },
              {
                id: 'remember',
                type: 'invoke',
                use: 'memoryUpdater',
                with: {
                  memoryRef: null,
                  goal: 'Update memory',
                  evidenceRefs: [],
                },
              },
              { id: 'validate', type: 'invoke', use: 'driver', with: {} },
              {
                id: 'select',
                type: 'invoke',
                use: 'selector',
                with: {
                  incumbentMeasurementRef:
                    '${{ steps.baseline.output.measurementRef }}',
                  candidateMeasurementRef:
                    '${{ steps.validate.output.measurementRef }}',
                },
              },
              {
                id: 'save',
                type: 'state',
                state: { selected: '${{ steps.select.output }}' },
              },
            ],
          },
          { id: 'test', type: 'invoke', use: 'driver', with: {} },
        ],
        output: {
          candidateRef: '${{ state.selected.selectedCandidateRef }}',
          measurementRef: '${{ state.selected.measurementRef }}',
          testMeasurementRef: '${{ steps.test.output.measurementRef }}',
        },
      },
    },
  );
  t.after(() => fixture.dispose());
  const facts = fixture.manager.facts;
  const write = facts.write.bind(facts);
  let interrupt = true;
  t.mock.method(
    facts,
    'write',
    async (kind: string, id: string, value: JsonObject) => {
      if (
        interrupt &&
        kind === 'checkpoint-entries' &&
        value.path === 'steps/search/iteration-0/train'
      ) {
        interrupt = false;
        throw new Error('Interrupted checkpoint write');
      }
      return write(kind, id, value);
    },
  );
  const terminal: string[] = [];
  let releaseScores!: () => void;
  const scoresAvailable = new Promise<void>((resolve) => {
    releaseScores = resolve;
  });
  t.after(releaseScores);
  const logging = configureCliLogging(true, (line) => {
    terminal.push(line);
    if (line.includes('Failed memoryUpdater')) releaseScores();
  });
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const run = (...flags: string[]) =>
    fixtureCommand(fixture, logging)(
      'run',
      join(workspace, 'recipe.yaml'),
      '--id',
      'resume-scores',
      ...flags,
    );
  assert.equal((await run()).exitCode, 1);
  assert.match(terminal.join(''), /Interrupted checkpoint write/);
  assert.equal(evaluations, 2);

  const [baseline, train] = await Promise.all(
    ['steps/baseline', 'steps/search/iteration-0/train'].map(async (path) => {
      const call = (await facts.list('calls')).find(
        (receipt) => receipt.path === path,
      );
      return facts.read(
        'measurements',
        String(object(call?.output).measurementRef),
      );
    }),
  );
  const artifacts = fixture.manager.artifacts;
  const read = artifacts.readJson.bind(artifacts);
  let missingTrainItems = false;
  t.mock.method(artifacts, 'readJson', async (ref: string) => {
    if (ref === baseline!.itemsRef) await scoresAvailable;
    if (missingTrainItems && ref === train!.itemsRef)
      throw new Error('Missing items artifact');
    return read(ref);
  });
  terminal.length = 0;
  const resumed = await run('--resume');
  const output = terminal.join('');
  assert.equal(resumed.exitCode, 0, output);
  assert.equal(evaluations, 4);
  assert.equal(memories, 1);
  assert.match(
    output,
    /Failed memoryUpdater[\s\S]*Reused Baseline · driver[^\n]*\n {11}├─ task · succeeded · score=0\.0000/,
  );
  assert.match(
    output,
    /Reused Round 1 · driver \(train\)[^\n]*\n {11}├─ task · succeeded · score=0\.2500/,
  );
  assert.match(
    output,
    /Completed selector \(select\) [^\n]*accepted · score 0\.0000 → 0\.7500 \(\+0\.7500\)/,
  );
  assert.match(
    output,
    /Summary\n {11}├─ Baseline · candidate-aaaaaaaa · score 0\.0000\n {11}├─ Round 1 · accepted [^\n]*\n {11}├─ Test · candidate-aaaaaaaa · score 0\.5000\n {11}├─ Selected · candidate-aaaaaaaa · score 0\.7500\n\s*Finished/,
  );
  assert.equal(
    JSON.parse(resumed.stdout ?? '').output.candidateRef,
    candidateRef,
  );
  assert.doesNotMatch(output, new RegExp(candidateRef));

  missingTrainItems = true;
  terminal.length = 0;
  assert.equal((await run('--resume')).exitCode, 0);
  assert.equal(evaluations, 4);
  assert.equal(memories, 1);
  const replay = terminal.join('');
  assert.match(replay, /Reused Round 1 · driver \(train\)/);
  assert.doesNotMatch(replay, /Missing items artifact|score=0\.2500/);
  assert.match(
    replay,
    /Reused Round 1 · memoryUpdater \(remember\) [^\n]*previously failed/,
  );
  assert.equal(replay.match(/score=0\.7500/g)?.length, 1);
  const saved = await readFile(
    join(workspace, '.rsi', 'logs', 'resume-scores.log'),
    'utf8',
  );
  assert.match(saved, new RegExp(candidateRef));
  assert.doesNotMatch(saved, /Reused| : Summary|score=0\.0000/);
});

test('run failures log the original stack once and turn repeated causes into a single summary', async (t) => {
  const token = 'secret-cli-logging-fixture';
  const literal = 'literal-recipe-credential-fixture';
  process.env.ARSI_LOG_TEST_TOKEN = token;
  const nested = new AggregateError(
    [
      new Error(`Denied with ${token}`),
      new Error(`Configured credential ${literal}`),
    ],
    'service refused the request',
  );
  const failure = new Error(nested.message, { cause: nested });
  nested.errors.push(nested);
  const fixture = await managerFixture(
    async () => {
      throw failure;
    },
    { config: { api_key: literal } },
  );
  t.after(() => fixture.dispose());
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const result = await fixtureCommand(fixture, logging)(
    'run',
    join(workspace, 'recipe.yaml'),
    '--id',
    'failed-run',
  );
  assert.deepEqual(result, { exitCode: 1 });
  const output = terminal.join('');
  assert.equal(output.match(/service refused the request/g)?.length, 1);
  assert.match(
    output,
    /Failed driver \(drive\)[^\n]*\n {11}service refused the request/,
  );
  assert.match(
    output,
    /Finished failed-run failed in [\s\S]*Log \.rsi\/logs\/failed-run\.log/,
  );
  assert.doesNotMatch(output, /\n +at |Exit 1|secret-cli-logging-fixture/);
  assert.ok(!output.includes(literal));
  assert.match(output, /Configured credential \[redacted\]/i);
  const saved = await readFile(
    join(workspace, '.rsi', 'logs', 'failed-run.log'),
    'utf8',
  );
  assert.equal(saved.match(/\nError: service refused the request/g)?.length, 1);
  assert.match(
    saved,
    /\n +at .*\nCaused by: AggregateError: service refused the request/s,
  );
  assert.match(saved, /Caused by: Error: Denied with \[REDACTED\]/);
  assert.match(saved, /Caused by: Error: Configured credential \[redacted\]/i);
  assert.ok(!saved.includes(literal));
  assert.match(saved, /Caused by: \[circular error\]/);
  assert.doesNotMatch(saved, /secret-cli-logging-fixture|\x1b/);
  assert.doesNotMatch(formatErrorStack(failure), /secret-cli-logging-fixture/);
});

test(
  'a replay read that outlasts the CLI grace period cannot write into the finishing report',
  { timeout: 3000 },
  async (t) => {
    const { manager, dispose } = await managerFixture(async () => ({}));
    t.after(dispose);
    await manager.facts.write('measurements', 'measurement-old', {
      experimentId: 'old',
      callId: 'baseline',
      itemsRef: 'pending-items',
    });
    let release!: (items: JsonObject) => void;
    const pending = new Promise<JsonObject>((resolve) => {
      release = resolve;
    });
    t.after(() => release({}));
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    t.mock.method(manager.artifacts, 'readJson', async () => {
      reading();
      return pending;
    });
    const terminal: string[] = [];
    const logging = configureCliLogging(true, (line) => terminal.push(line));
    t.after(() => logging.dispose());
    await logging.run(
      { noLogFile: true },
      async () => {
        const replay = createResumeReport(manager);
        replay.onReusedCalls([
          {
            experimentId: 'old',
            callId: 'baseline',
            bindingId: 'evaluator',
            path: 'steps/baseline',
            status: 'succeeded',
            output: { measurementRef: 'measurement-old' },
          },
        ]);
        await started;
        await replay.finish();
        release({ items: [{ id: 'late-score', status: 'succeeded' }] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.doesNotMatch(terminal.join(''), /late-score/);
      },
      { command: 'run' },
    );
    assert.match(terminal.join(''), /Reused Baseline · evaluator/);
  },
);

test('Operator Search reports both search phases in order, including the baseline and final retest', async (t) => {
  const { manager, dispose } = await managerFixture(async () => ({}));
  t.after(dispose);
  const experimentId = 'operator-fixture';
  const candidateRef = 'candidate-' + 'b'.repeat(32);
  const calls = [
    ['steps/evaluate_baseline', { measurementRef: 'measurement-base' }],
    [
      'steps/static_search/iteration-0/assess/then/select',
      { incumbentValue: 10, candidateValue: 9 },
    ],
    [
      'steps/static_search/iteration-1/assess/then/select',
      { incumbentValue: 9, candidateValue: 8 },
    ],
    [
      'steps/run_metrics/then/metrics_loop/iteration-0/assess_metrics_proposal/then/metrics_select',
      { incumbentValue: 8, candidateValue: 6 },
    ],
  ] as const;
  for (const [index, [path, output]] of calls.entries()) {
    await manager.facts.write('calls', 'call-' + index, {
      experimentId,
      path,
      parentCallId: 'root',
      status: 'succeeded',
      startedAt: '2026-11-25T10:00:0' + index + '.000Z',
      ...('candidateValue' in output
        ? {
            contractId: metricSelectorContract.id,
            output: {
              ...output,
              accepted: true,
              metric: 'latencyMs',
              selectedValue: output.candidateValue,
            },
          }
        : { output }),
    });
  }
  for (const [ref, value] of [
    ['measurement-base', 10],
    ['measurement-best', 6],
    ['measurement-final', 6.2],
  ] as const) {
    await manager.facts.write('measurements', ref, {
      ref,
      experimentId,
      candidateRef,
      metrics: {
        latencyMs: { status: 'available', value: { kind: 'scalar', value } },
      },
    });
  }
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (line) => terminal.push(line));
  t.after(() => logging.dispose());
  await logging.run(
    { noLogFile: true },
    () =>
      reportRunSummary(manager, experimentId, {
        status: 'succeeded',
        output: {
          bestCandidateRef: candidateRef,
          bestMeasurementRef: 'measurement-best',
          finalMeasurementRef: 'measurement-final',
        },
      }),
    { command: 'run', experimentId },
  );
  const output = terminal.join('');
  assert.match(
    output,
    /Baseline · candidate-bbbbbbbb · latencyMs 10\.0000[\s\S]*Static · Round 1[\s\S]*Static · Round 2[\s\S]*Metrics · Round 1/,
  );
  assert.match(
    output,
    /Retest · candidate-bbbbbbbb · latencyMs 6\.2000[\s\S]*Selected · candidate-bbbbbbbb · latencyMs 6\.0000/,
  );
});

test('Cargo Doctor prints each failed check through the report and preserves it in the log file', async (t) => {
  const fixture = await managerFixture(async () => ({}));
  t.after(() => fixture.dispose());
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (line) => terminal.push(line));
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const logFile = join(workspace, 'doctor.log');
  for (const flags of [[], ['--json']]) {
    const result = await fixtureCommand(fixture, logging)(
      'doctor',
      join(workspace, 'missing.yaml'),
      '--log-file',
      logFile,
      ...flags,
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout ?? '', /recipe\.validate/);
  }
  assert.doesNotMatch(terminal.join(''), /recipe\.validate/);
  assert.match(await readFile(logFile, 'utf8'), /Failed recipe\.validate/);
});

test('quiet commands show the log path only after a failure with file logging', async (t) => {
  const fixture = await managerFixture(async () => {
    throw new Error('evaluation failed');
  });
  t.after(() => fixture.dispose());
  const terminal: string[] = [];
  const logging = configureCliLogging(false, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const command = fixtureCommand(fixture, logging);
  const recipe = join(workspace, 'recipe.yaml');

  const failure = await command('run', recipe, '--id', 'quiet-failure', '-q');
  assert.equal(failure.exitCode, 1);
  assert.match(
    terminal.join(''),
    /evaluation failed\nLog \.rsi\/logs\/quiet-failure\.log\n$/,
  );
  const directory = join(workspace, '.rsi', 'logs');
  const saved = await readFile(join(directory, 'quiet-failure.log'), 'utf8');
  assert.match(saved, /Error: evaluation failed/);
  assert.doesNotMatch(saved, /arsi\.cli\s+: Log /);

  terminal.length = 0;
  const disabled = await command(
    'run',
    recipe,
    '--id',
    'quiet-disabled',
    '-q',
    '--no-log-file',
  );
  assert.equal(disabled.exitCode, 1);
  assert.match(terminal.join(''), /evaluation failed/);
  assert.doesNotMatch(terminal.join(''), /Log /);
  await assert.rejects(stat(join(directory, 'quiet-disabled.log')), {
    code: 'ENOENT',
  });

  terminal.length = 0;
  assert.equal((await command('list', '-q')).exitCode, 0);
  assert.equal(terminal.join(''), '');
});

test('log files honor explicit paths, disable flags and workspace boundaries', async (t) => {
  const fixture = await managerFixture(async () => ({}));
  t.after(() => fixture.dispose());
  const logging = configureCliLogging(false, () => {});
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const command = fixtureCommand(fixture, logging);
  const explicit = join(workspace, 'nested', 'logs', 'output.log');

  assert.equal((await command('list')).exitCode, 0);
  await assert.rejects(stat(join(workspace, '.rsi')), { code: 'ENOENT' });
  for (const args of [
    ['--no-log-file', '--log-file', explicit],
    ['--log-file', explicit, '--no-log-file'],
  ]) {
    assert.equal((await command('list', ...args)).exitCode, 0);
    await assert.rejects(stat(explicit), { code: 'ENOENT' });
  }
  assert.equal(
    (await command('list', '--log-file', explicit, '--quiet')).exitCode,
    0,
  );
  assert.match(await readFile(explicit, 'utf8'), /Starting list/);
  await mkdir(join(workspace, '.rsi'));
  assert.equal((await command('list')).exitCode, 0);
  assert.equal((await command('list')).exitCode, 0);
  const shared = await readFile(
    join(workspace, '.rsi', 'logs', 'cli.log'),
    'utf8',
  );
  assert.equal(shared.match(/Starting list/g)?.length, 2);
});

test('an explicit log file overrides the shell default for just one command', async (t) => {
  const fixture = await managerFixture(async () => ({}));
  t.after(() => fixture.dispose());
  const logging = configureCliLogging(false, () => {});
  t.after(() => logging.dispose());
  const workspace = fixture.manager.rootDirectory;
  const command = fixtureCommand(fixture, logging, {
    pluginDir: [],
    noLogFile: true,
  });
  const explicit = join(workspace, 'command.log');

  await mkdir(join(workspace, '.rsi'));
  assert.equal((await command('list', '--log-file', explicit)).exitCode, 0);
  const saved = await readFile(explicit, 'utf8');
  assert.match(saved, /Starting list/);

  assert.equal((await command('list')).exitCode, 0);
  assert.equal(await readFile(explicit, 'utf8'), saved);
  await assert.rejects(stat(join(workspace, '.rsi', 'logs')), {
    code: 'ENOENT',
  });
});

test('terminal modes follow the command and resolved level while the file keeps debug context', async (t) => {
  const workspace = await temporaryWorkspace(t);
  await mkdir(join(workspace, '.rsi'));
  const terminal: string[] = [];
  const pipe = configureCliLogging(false, (text) => terminal.push(text));
  try {
    await pipe.run(
      {},
      async () => {
        runtimeLogger.debug('debug detail');
        cliLogger.warning('pipe warning');
      },
      { command: 'list', workspace },
    );
    assert.deepEqual(terminal.splice(0), ['pipe warning\n']);
    assert.match(
      await readFile(join(workspace, '.rsi', 'logs', 'cli.log'), 'utf8'),
      /DEBUG.*debug detail/,
    );

    await pipe.run(
      { logLevel: parseLogLevels('info') },
      async () => {
        cliLogger.info('explicit pipe level');
      },
      { command: 'list', workspace },
    );
    assert.match(
      terminal.splice(0).join(''),
      /INFO .*\[list\].*explicit pipe level/,
    );

    await pipe.run(
      {},
      async () => {
        getLogger(['arsi', 'web']).info('GET /api/experiments -> 200 (4ms)');
      },
      { command: 'dashboard', workspace },
    );
    assert.match(
      terminal.splice(0).join(''),
      /INFO .*\[dashboard\].*GET \/api\/experiments/,
    );

    process.env.ARSI_LOG_LEVEL = 'warning';
    process.env.ARSI_LOG_LEVELS = 'cli=error,cli.runtime=trace';
    const explicit = parseLogLevels('cli=info', parseLogLevels('info'));
    await pipe.run(
      { logLevel: explicit, quiet: true },
      async () => {
        cliLogger.info('CLI override kept in file');
        runtimeLogger.trace('environment override kept in file');
        cliLogger.error('quiet still reports errors');
      },
      { command: 'list', workspace },
    );
    assert.match(terminal.join(''), /ERROR.*quiet still reports errors/);
    assert.doesNotMatch(terminal.join(''), /kept in file/);
    const saved = await readFile(
      join(workspace, '.rsi', 'logs', 'cli.log'),
      'utf8',
    );
    assert.match(saved, /INFO.*CLI override kept in file/);
    assert.match(saved, /TRACE.*environment override kept in file/);
  } finally {
    pipe.dispose();
  }
});

test('debug progress records drive active tasks only in foreground mode', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const logFile = join(workspace, 'debug.log');
  const logging = configureCliLogging(true);
  t.after(() => logging.dispose());
  const lines: string[] = [];
  const tasks: Array<RunningTask | undefined> = [];
  const restore = logging.takeTerminal(
    (record, mode) => lines.push(`${mode}:${record.level}`),
    (task) => tasks.push(task),
  );
  t.after(restore);
  const activeTask = { id: 'one', label: 'evaluator (baseline)' };
  const evaluate = async () => {
    runtimeLogger.debug('Start call', { activeTask });
    reportTaskProgress(
      runtimeLogger,
      activeTask.id,
      'waiting\n\x1b[32mfor health\x1b[0m',
    );
    reportTaskProgress(runtimeLogger, activeTask.id, 'waiting for health');
    runtimeLogger.info('Finish call', {
      activeTask: { id: activeTask.id, done: true },
    });
  };
  await logging.run({ noLogFile: true }, evaluate, { command: 'run' });
  assert.deepEqual(lines, ['cargo:info']);
  assert.equal(tasks[0]?.label, 'evaluator (baseline)');
  assert.deepEqual(tasks[1], { ...tasks[0], detail: 'waiting for health' });
  assert.equal(tasks[2], undefined);
  assert.equal(tasks.length, 3);

  process.env.ARSI_LOG_LEVELS = 'cli.runtime=debug';
  await logging.run({ logFile }, evaluate, { command: 'run' });
  assert.deepEqual(lines.slice(1), [
    'spring:debug',
    'spring:info',
    'spring:info',
  ]);
  assert.equal(tasks.length, 3);
  const saved = await readFile(logFile, 'utf8');
  assert.match(saved, /DEBUG.*Start call/);
  assert.doesNotMatch(saved, /waiting|for health/);
});

test('SDK progress uses live counters and logs each phase and task outcome once', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const logFile = join(workspace, 'evaluator.log');
  const context = new RuntimeContext().extend({
    experimentId: 'live-eval',
    bindingId: 'evaluator',
    callId: 'eval-call',
  });
  const first = {
    phase: 'solve',
    taskId: 'task-a',
    attemptId: 'a',
    taskTotal: 5,
  };
  const completion = {
    phase: 'task',
    taskId: 'task-c',
    attemptId: 'c',
    message: 'Finished: completed; score=0.8; progress 3/5',
  };
  const retry = {
    phase: 'retry',
    taskId: 'task-b',
    attemptId: 'b',
    warning: true,
    message: 'Retrying the task',
  };
  const events: ProgressEvent[] = [
    { phase: 'deployment', message: 'Submitting cluster job' },
    { ...first, message: 'Solving first task' },
    { ...first, message: 'Duplicate phase detail' },
    {
      ...first,
      transient: true,
      message: 'Heartbeat detail',
      live: {
        id: 'solve-a',
        sequence: 1,
        status: 'updated',
        elapsedMs: 70_000,
        idleMs: 65_000,
        lines: ['Native heartbeat text'],
      },
    },
    {
      phase: 'solve',
      taskId: 'task-b',
      attemptId: 'b',
      message: 'Solving second task',
    },
    {
      phase: 'verify',
      taskId: 'task-c',
      attemptId: 'c',
      message: 'Verifying third task',
      summary: { total: 5, prepared: 4, completed: 2 },
    },
    completion,
    completion,
    retry,
    retry,
  ];
  const stopped = new Error('End of SDK fixture');
  t.mock.method(
    Evaluator.prototype,
    'run',
    async (options: EvaluatorRunOptions) => {
      for (const event of events) options.onProgress?.(event);
      throw stopped;
    },
  );
  const logging = configureCliLogging(true);
  t.after(() => logging.dispose());
  const terminal: string[] = [];
  const details: Array<string | undefined> = [];
  t.after(
    logging.takeTerminal(
      (record) => terminal.push(formatCargoLine(record)),
      (task) => details.push(task?.detail),
    ),
  );
  const forwarded: ProgressEvent[] = [];
  await assert.rejects(
    logging.run(
      { logFile },
      async () => {
        runtimeLogger.debug('Start evaluator', {
          activeTask: { id: context.callId, label: 'evaluator' },
        });
        return sdkRunner(
          {
            configPath: join(workspace, 'recipe.yaml'),
            onProgress: (event) => forwarded.push(event),
          },
          { context },
        );
      },
      { command: 'run', experimentId: context.experimentId, workspace },
    ),
    (error) => error === stopped,
  );
  assert.deepEqual(forwarded, events);
  assert.ok(details.includes('[deployment] Submitting cluster job'));
  assert.ok(details.includes('done 0/5 · task-a [solve] · idle 65s'));
  assert.ok(details.includes('ready 4/5 · done 2/5 · solving 2 · verifying 1'));
  const milestone = 'Progress evaluator · 3/5 task-c completed · score=0.8';
  assert.equal(
    terminal.filter(
      (line) => line.trim() === '├─ 3/5 task-c completed · score=0.8',
    ).length,
    1,
  );
  assert.equal(
    terminal.filter((line) => line.trim().startsWith('├─ Retrying ')).length,
    1,
  );
  assert.doesNotMatch(
    terminal.join('\n'),
    /Solving first task|Verifying third task|Heartbeat detail/,
  );
  const saved = await readFile(logFile, 'utf8');
  assert.match(saved, /DEBUG.*task-a \[solve\] Solving first task/);
  assert.equal(saved.split(milestone).length - 1, 1);
  assert.doesNotMatch(
    saved,
    /Duplicate phase detail|Heartbeat detail|Native heartbeat text|idle 65s/,
  );
});

test('managed Agent observations drive call-local progress using only turns and tool names', async (t) => {
  const agent: OperationDefinition = {
    id: 'test.progress-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, context) {
          const emit = (
            event: AgentObservation['event'],
            runId = 'main',
          ): void => {
            context.event.emit('rsi/agent-observation', { runId, event });
          };
          emit({
            type: 'message.completed',
            role: 'assistant',
            messageId: 'one',
            text: 'private assistant text',
          });
          const tool = {
            type: 'tool.started',
            toolCallId: 'read',
            name: 'read_file',
            input: 'private tool input',
          } as const;
          emit(tool);
          emit(tool);
          emit({
            type: 'tool.completed',
            toolCallId: 'read',
            status: 'succeeded',
            output: 'private tool output',
          });
          emit({
            type: 'subagent.activity',
            activity: 'started',
            childRunId: 'child',
          });
          emit(
            {
              type: 'message.completed',
              role: 'assistant',
              messageId: 'child-message',
              text: 'private child text',
            },
            'child',
          );
          emit({ type: 'run.finished', status: 'completed' }, 'child');
          emit({
            type: 'tool.started',
            toolCallId: 'task',
            name: 'Task',
            input: 'private task input',
          });
          emit({
            type: 'subagent.activity',
            activity: 'started',
            childRunId: 'task',
          });
          emit({
            type: 'tool.completed',
            toolCallId: 'task',
            status: 'succeeded',
            output: null,
          });
          emit({
            type: 'message.completed',
            role: 'assistant',
            messageId: 'final',
            text: 'private final text',
            phase: 'final_answer',
          });
          return {};
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) =>
      context.invokeAgent('agent', {
        cwd: await prepareAgentProject(context, 'test', {}, [], []),
        goal: 'private goal',
        outputSchema: { type: 'object' },
      }),
    { plugins: [agent], bindings: { agent: { plugin: agent.id, config: {} } } },
  );
  t.after(() => fixture.dispose());
  const logging = configureCliLogging(true);
  t.after(() => logging.dispose());
  const tasks: Array<RunningTask | undefined> = [];
  t.after(
    logging.takeTerminal(
      () => {},
      (task) => tasks.push(task),
    ),
  );
  const workspace = fixture.manager.rootDirectory;
  const result = await fixtureCommand(fixture, logging)(
    'run',
    join(workspace, 'recipe.yaml'),
    '--id',
    'agent-progress',
  );
  assert.equal(result.exitCode, 0);
  const agentTasks = tasks.filter(
    (task) => task?.label === 'driver (drive) → agent',
  );
  assert.deepEqual(
    agentTasks.map((task) => task?.detail),
    [
      undefined,
      'turn 1 · thinking',
      'turn 2 · thinking',
      'turn 2 · tool read_file',
      'turn 2 · thinking',
      'turn 2 · subagent',
      'turn 2 · thinking',
      'turn 2 · tool Task',
      'turn 2 · subagent',
      'turn 2 · thinking',
      'finalizing',
    ],
  );
  assert.equal(new Set(agentTasks.map((task) => task?.startedAt)).size, 1);
  assert.match(
    tasks[tasks.indexOf(agentTasks.at(-1)) + 1]?.label ?? '',
    /^driver/,
  );
  const saved = await readFile(
    join(workspace, '.rsi', 'logs', 'agent-progress.log'),
    'utf8',
  );
  assert.equal(saved.match(/DEBUG.*agent turn 2 tool read_file/g)?.length, 1);
  assert.doesNotMatch(saved, /private |finalizing|turn 2 ·|turn 3/);
});
