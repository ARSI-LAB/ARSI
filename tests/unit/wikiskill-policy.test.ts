import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { memoryDefinition } from '../../src/plugins/memory-agent/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { Policy } from '../../src/runtime/compiler/index.js';
import { object, string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

async function loadWikiPolicy(t: TestContext): Promise<Policy> {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  return Policy.load('src/policies/wikiskill/policy.yaml', registry);
}

test('memory receives authorized summary and current skills, persists Wiki and releases its workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-wiki-memory-'));
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const registry = new Registry();
  const workspaces = new FileWorkspaces(join(root, 'workspaces'), artifacts);
  try {
    const prompt = join(root, 'prompt.md');
    await writeFile(prompt, 'Record observed skills and summary feedback.');
    const candidateArtifact = await artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'plugins/base/skills/check/SKILL.md',
          mode: 420,
          base64: Buffer.from('Check completed work.').toString('base64'),
        },
      ],
    });
    const observations = {
      status: 'evaluated',
      accepted: false,
      candidateRef: 'rejected',
      candidateValue: 0.4,
      selectedValue: 0.6,
    };
    const input = {
      memoryRef: null,
      goal: 'Maintain Wiki.',
      evidenceRefs: ['train-measurement'],
      observations,
      sources: [{ candidateRef: 'incumbent' }],
    };
    validate(memoryDefinition.contract.input_schema, input);
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected service');
    };
    let calls = 0;
    const services: RuntimeContext = new RuntimeContext().extend({
      rootDirectory: root,
      dataDirectory: root,
      artifacts,
      workspaces,
      facts: new FileFacts(join(root, 'facts')),
      readCandidate: async (ref) => {
        assert.equal(ref, 'incumbent');
        return {
          ref,
          artifactRef: candidateArtifact,
          parentRef: null,
          experimentId: 'experiment',
        };
      },
      recordCandidate: unused,
      recordMeasurement: unused,
      readMeasurement: unused,
      application: unused,
      applicationMetadata: unused,
      invoke: unused,
      withInstance: unused,
      charge: unused,
      readEvidence: async (refs) => {
        assert.deepEqual(refs, ['train-measurement']);
        return { training: 'Observed execution' };
      },
      invokeAgent: async (request) => {
        const supplied = object(request.input);
        assert.deepEqual(supplied.observations, observations);
        assert.equal(
          object(request.files)['sources/0/plugins/base/skills/check/SKILL.md'],
          'Check completed work.',
        );
        calls++;
        return calls === 1
          ? {
              edits: [
                {
                  path: 'wiki/index.md',
                  content: 'Rejected trial; retain existing skill.',
                },
              ],
              reason: 'Recorded feedback.',
            }
          : { edits: [], reason: 'Already recorded.' };
      },
    });
    const context: RuntimeContext = new RuntimeContext().extend({
      experimentId: 'experiment',
      callId: 'remember',
      bindingId: 'memory',
      idempotencyKey: 'remember',
      directory: root,
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    });
    registry.registerOperation(memoryDefinition);
    const memory = await registry
      .get('memory.agent')
      .create({ prompt }, services);
    try {
      const updated = object(
        await memory.execute(input, context.extend(services)),
      );
      validate(memoryDefinition.contract.output_schema, updated);
      assert.equal(updated.status, 'updated');
      const snapshot = join(root, 'snapshot');
      await artifacts.materialize(string(updated.memoryRef), snapshot);
      assert.equal(
        await readFile(join(snapshot, 'wiki/index.md'), 'utf8'),
        'Rejected trial; retain existing skill.',
      );
      const retained = object(
        await memory.execute(
          { ...input, memoryRef: updated.memoryRef! },
          context.extend(services),
        ),
      );
      assert.equal(retained.status, 'no-change');
      assert.equal(retained.memoryRef, updated.memoryRef);
      assert.equal(retained.changeRef, null);
      assert.deepEqual(await readdir(join(root, 'workspaces')), []);
      for (const content of ['Tampered source.', null]) {
        services.invokeAgent = async () => ({
          edits: [
            { path: 'sources/0/plugins/base/skills/check/SKILL.md', content },
          ],
          reason: 'Attempt to modify read-only source.',
        });
        await assert.rejects(
          memory.execute(
            { ...input, memoryRef: updated.memoryRef! },
            context.extend(services),
          ),
          /read-only source/,
        );
        assert.deepEqual(await readdir(join(root, 'workspaces')), []);
      }
      const shadow = await artifacts.putJson({
        kind: 'file-tree',
        files: [
          {
            path: 'sources/0/plugins/base/skills/check/SKILL.md',
            mode: 420,
            base64: Buffer.from('Shadowed source.').toString('base64'),
          },
        ],
      });
      services.invokeAgent = unused;
      await assert.rejects(
        memory.execute(
          { ...input, memoryRef: shadow },
          context.extend(services),
        ),
        /source.*shadow|shadow.*source/,
      );
      assert.deepEqual(await readdir(join(root, 'workspaces')), []);
    } finally {
      await memory.dispose();
    }
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('WikiSkill skips no-change evaluation, retains Wiki across rejection, stops at target and resumes without repeated calls', async (t) => {
  const policy = await loadWikiPolicy(t);
  const scores: Record<string, number> = { h0: 0.5, c1: 0.8, c2: 0.7, c3: 1 };
  const measurements = new Map<string, { candidate: string; score: number }>();
  const evaluations: JsonObject[] = [];
  const memories: JsonObject[] = [];
  const parents: string[] = [];
  let checkpoint: JsonObject = {};
  let proposals = 0;
  const input = { candidateRef: 'h0' };
  const config = {
    maxRounds: 8,
    stopAtScore: 1,
    dataset: {
      trainTaskIds: ['train'],
      validationTaskIds: ['val'],
      testTaskIds: ['test'],
    },
  };
  const options = {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
    },

    invoke: async (name: string, raw: unknown): Promise<JsonObject> => {
      const value = object(raw);
      if (name === 'evaluator') {
        evaluations.push(value);
        const ref = `m${evaluations.length}`;
        const candidate = string(value.candidateRef);
        measurements.set(ref, { candidate, score: scores[candidate]! });
        return { measurementRef: ref };
      }
      if (name === 'memoryUpdater') {
        memories.push(value);
        return {
          status: 'updated',
          memoryRef: `wiki${memories.length}`,
          changeRef: `memory-change${memories.length}`,
          reason: 'Training and summary feedback recorded.',
        };
      }
      if (name === 'proposer') {
        parents.push(string(value.parent));
        assert.equal(value.memoryRef, `wiki${memories.length}`);
        const index = proposals++;
        return {
          status: index === 0 ? 'no-change' : 'created',
          candidateRef: index === 0 ? value.parent! : `c${index}`,
          diffRef: index === 0 ? null : `diff${index}`,
          rationale: index === 0 ? 'No useful edit.' : `Try skill ${index}.`,
        };
      }
      assert.equal(name, 'selector');
      const before = measurements.get(string(value.incumbentMeasurementRef))!;
      const after = measurements.get(string(value.candidateMeasurementRef))!;
      const accepted = after.score > before.score;
      return {
        accepted,
        candidateFeasible: true,
        selectedCandidateRef: accepted ? after.candidate : before.candidate,
        measurementRef: accepted
          ? value.candidateMeasurementRef!
          : value.incumbentMeasurementRef!,
        decisionRef: 'decision',
        reason: accepted ? 'Improved.' : 'Retain incumbent.',
        metric: 'meanReward',
        incumbentValue: before.score,
        candidateValue: after.score,
        selectedValue: accepted ? after.score : before.score,
      };
    },
  };
  const output = object(
    await policy.execute({ input: input, config: config, ...options }),
  );
  assert.equal(proposals, 4);
  assert.deepEqual(parents, ['h0', 'h0', 'c1', 'c1']);
  assert.equal(evaluations.length, 9);
  assert.deepEqual(evaluations.at(-1), {
    candidateRef: 'c3',
    taskIds: ['test'],
  });
  assert.equal(output.candidateRef, 'c3');
  assert.equal(output.memoryRef, 'wiki4');
  assert.equal(output.testMeasurementRef, 'm9');
  assert.equal(memories[0].observations, null);
  assert.equal(object(memories[1].observations).status, 'no-change');
  assert.equal(object(memories[2].observations).accepted, true);
  const rejected = object(memories[3].observations);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.candidateRef, 'c2');
  assert.equal(rejected.candidateValue, 0.7);
  assert.equal(rejected.selectedValue, 0.8);
  for (const memory of memories) {
    assert.equal((memory.evidenceRefs as string[]).length, 1);
    const ref = (memory.evidenceRefs as string[])[0]!;
    const evaluation = evaluations[Number(ref.slice(1)) - 1]!;
    assert.deepEqual(evaluation.taskIds, ['train']);
    assert.equal(
      object((memory.sources as JsonObject[])[0]).candidateRef,
      evaluation.candidateRef,
    );
  }
  const restored = await policy.execute({
    input: input,
    config: config,
    ...options,
    restore: checkpoint,
    invoke: async () => {
      throw new Error('Completed calls must not repeat');
    },
  });
  assert.deepEqual(restored, output);
});

test('WikiSkill full-score baseline stops only with an explicit threshold', async (t) => {
  const policy = await loadWikiPolicy(t);
  for (const threshold of [1, null]) {
    let trains = 0;
    const result = object(
      await policy.execute({
        input: { candidateRef: 'h0' },
        config: {
          maxRounds: 2,
          stopAtScore: threshold,
          dataset: {
            trainTaskIds: ['train'],
            validationTaskIds: ['val'],
            testTaskIds: [],
          },
        },
        application: {},
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        checkpoint: async () => {},

        invoke: async (name, raw): Promise<JsonObject> => {
          const value = object(raw);
          if (name === 'evaluator') {
            if ((value.taskIds as string[])[0] === 'train') trains++;
            return { measurementRef: 'm1' };
          }
          if (name === 'selector')
            return {
              accepted: false,
              candidateFeasible: true,
              selectedCandidateRef: 'h0',
              measurementRef: 'm1',
              decisionRef: 'd',
              reason: 'Tie.',
              metric: 'meanReward',
              incumbentValue: 1,
              candidateValue: 1,
              selectedValue: 1,
            };
          if (name === 'memoryUpdater')
            return {
              status: 'no-change',
              memoryRef: value.memoryRef!,
              changeRef: null,
              reason: 'No update.',
            };
          return {
            status: 'no-change',
            candidateRef: 'h0',
            diffRef: null,
            rationale: 'No edit.',
          };
        },
      }),
    );
    assert.equal(trains, threshold === null ? 2 : 0);
    assert.equal(result.candidateRef, 'h0');
    assert.equal(result.testMeasurementRef, null);
  }
});
