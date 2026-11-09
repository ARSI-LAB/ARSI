import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../src/contracts/index.js';
import { normalizeEvaluation } from '../../src/plugins/evaluator-agentbench/measurement.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

const promptMarker = 'PUBLIC_TASK_INPUT_MARKER';
const answerMarker = 'PRIVATE_REFERENCE_ANSWER_MARKER';
const verifierMarker = 'PRIVATE_VERIFIER_MARKER';

async function normalizeTask(
  context: RuntimeContext,
  task: JsonValue,
): Promise<string> {
  const runDirectory = join(context.directory, 'sdk');
  const attemptDirectory = join(
    runDirectory,
    'tasks',
    'task',
    'attempts',
    'attempt',
  );
  const record: JsonObject = {
    key: { runId: 'native', taskId: 'task/a', attemptId: 'attempt' },
    executionStatus: 'completed',
    scoreStatus: 'valid',
    cleanupStatus: 'cleaned',
    task,
    solve: { finalText: 'PUBLIC_OBSERVABLE_OUTPUT', usage: {} },
    verdict: { passed: false, score: 0.5, details: {} },
    errors: [],
    collection: { trajectory: 'complete', artifacts: 'not-produced' },
  };
  for (const directory of ['agent', 'verifier'])
    await mkdir(join(attemptDirectory, directory), { recursive: true });
  await writeFile(
    join(attemptDirectory, 'result.json'),
    JSON.stringify(record),
  );
  await writeFile(
    join(attemptDirectory, 'agent', 'session.jsonl'),
    'PUBLIC_TRAJECTORY',
  );
  await writeFile(
    join(attemptDirectory, 'verifier', 'private.txt'),
    verifierMarker,
  );
  return normalizeEvaluation(
    {
      services: { default: { model: 'fixture', base_url: 'http://fixture' } },
      benchmark: { name: 'workbuddy', solver: { name: 'agentbundle' } },
      run: { includeTaskAnswer: true },
    },
    { candidateRef: 'candidate-test', taskIds: ['task/a'] },
    {},
    {
      kind: 'local',
      exitCode: 0,
      runDirectory,
      snapshot: {
        digest: 'snapshot',
        run: {
          runId: 'native',
          evaluationKind: 'quality',
          status: 'completed',
          taskIds: ['task/a'],
          source: {
            source: 'fixture',
            revision: 'fixed',
            files: [],
            metadata: {},
          },
          identity: {
            evaluator: { name: 'fixture', version: '1' },
            runtime: { node: '24', platform: 'linux', arch: 'x64' },
          },
          solverProvenance: { harness: 'fixture' },
          pluginVersions: {},
          startedAt: '2026-11-06T00:00:00.000Z',
          finishedAt: '2026-11-06T00:00:01.000Z',
        },
        records: [record],
        pendingTaskIds: [],
      },
    },
    context,
  );
}

test('public execution evidence exposes the task prompt while preserving private answer and verifier evidence', async () => {
  const fixture = await managerFixture(async (context) => {
    const ref = await normalizeTask(context, {
      prompt: promptMarker,
      answer: answerMarker,
    });
    const measurement = await context.readMeasurement(ref);
    const index = object(
      await context.artifacts.readJson(string(measurement.evidenceIndexRef)),
    );
    assert.ok(Array.isArray(index.entries));
    const input = index.entries
      .map((entry) => object(entry))
      .find((entry) => entry.id === 'task/a/task-input');
    assert.ok(input);
    assert.equal(input.access, 'execution');
    assert.deepEqual(
      await context.artifacts.readJson(string(input.artifactRef)),
      {
        event: 'task-input',
        text: promptMarker,
      },
    );
    for (const options of [
      { view: 'execution' },
      { view: 'execution', format: 'files' },
    ] as const) {
      const projection = await context.readEvidence([ref], options);
      const text = JSON.stringify(projection);
      assert.match(text, new RegExp(promptMarker));
      assert.match(text, /PUBLIC_OBSERVABLE_OUTPUT/);
      assert.doesNotMatch(
        text,
        new RegExp(`${answerMarker}|${verifierMarker}`),
      );
    }
    const items = object(
      await context.artifacts.readJson(string(measurement.itemsRef)),
    );
    assert.ok(Array.isArray(items.items));
    const details = object(
      await context.artifacts.readJson(
        string(object(object(items.items[0]).details).artifactRef),
      ),
    );
    const original = object(
      await context.artifacts.readJson(
        string(object(details.selected).recordRef),
      ),
    );
    assert.equal(object(original.task).answer, answerMarker);
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

for (const prompt of [42, '   ']) {
  test(`invalid SDK task prompt ${JSON.stringify(prompt)} is rejected before recording a measurement`, async () => {
    const fixture = await managerFixture(async (context) => {
      await assert.rejects(
        normalizeTask(context, { prompt }),
        /SDK task.prompt/,
      );
      return {};
    });
    try {
      await fixture.run();
      assert.deepEqual(await fixture.manager.facts.list('measurements'), []);
    } finally {
      await fixture.dispose();
    }
  });
}
