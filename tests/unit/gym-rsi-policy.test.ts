import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  agentContract,
  gymContract,
  proposerContract,
  metricSelectorContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { readYaml } from '../../src/runtime/loaders/yaml.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';

const policyContracts = {
  [agentContract.id]: agentContract,
  [gymContract.id]: gymContract,
  [proposerContract.id]: proposerContract,
  [metricSelectorContract.id]: metricSelectorContract,
};

const policyContractResolver = {
  contract(id: string) {
    const contract = Object.hasOwn(policyContracts, id)
      ? policyContracts[id as keyof typeof policyContracts]
      : undefined;
    if (contract === undefined) throw new Error(`Unknown contract ${id}`);
    return contract;
  },
};

async function loadGymPolicy(): Promise<Policy> {
  return Policy.load(
    'src/policies/gym-rsi/policy.yaml',
    policyContractResolver,
  );
}

test('WikiSkill and Gym defaults exclude held-out evidence and authorize configured Proposer prompts, skills and roles', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  const skill = await mkdtemp(join(tmpdir(), 'rsi-wiki-skill-'));
  t.after(() => rm(skill, { recursive: true, force: true }));
  const role = join(skill, 'role.md');
  await writeFile(role, 'Review candidate skills.');
  for (const [example, holdout] of [
    ['dsh-wikiskill', 'test'],
    ['dsh-gym-gaia', 'promotion'],
  ] as const) {
    const sourcePath = 'examples/harness/' + example + '/recipe.yaml';
    const declaration = await readYaml(sourcePath);
    delete declaration.reflection;
    object(object(declaration.policy).config).maxRounds = 2;
    object(declaration.bindings).proposer = {
      config: {
        skills: [skill],
        subagents: [
          {
            name: 'reviewer',
            description: 'Review skill changes',
            prompt: role,
          },
        ],
      },
    };
    const recipe = await Recipe.fromJSON(declaration, registry, { sourcePath });
    assert.deepEqual(
      new Set(recipe.reflection?.targets.proposer?.resources),
      new Set(['/prompt', '/skills/0', '/subagents/0/prompt']),
    );
    assert.deepEqual(recipe.memory?.trigger, {
      on: 'after-step',
      step: 'train',
      every: 1,
    });
    for (const capability of [recipe.memory, recipe.reflection]) {
      assert.equal(capability?.evidenceView, 'training');
      const excluded = new Set(
        capability?.observe.excludeSteps?.map((path) => path.split('/').at(-1)),
      );
      for (const step of ['baseline', 'baseline_score', 'validate', holdout]) {
        assert.ok(excluded.has(step), example + ' must exclude ' + step);
      }
      assert.ok(!excluded.has('train'));
    }
  }
});

test('policy.gym-rsi keeps promotion as a top-level post-search step', async () => {
  const policy = await loadGymPolicy();
  const definition = policy.toJSON();
  const rawSteps = definition.steps;
  if (!Array.isArray(rawSteps)) throw new Error('Policy steps are missing');
  const promotionPaths: string[] = [];
  const visit = (steps: unknown[], path: string): void => {
    for (const step of steps) {
      if (step === null || typeof step !== 'object' || Array.isArray(step))
        continue;
      const record = object(step);
      const id = string(record.id, `${path}.id`);
      const stepPath = `${path}/${id}`;
      if (record.type === 'invoke' && record.use === 'promotion')
        promotionPaths.push(stepPath);
      for (const key of ['steps', 'then', 'else']) {
        const child = record[key];
        if (Array.isArray(child)) visit(child, stepPath);
        else if (
          child !== null &&
          typeof child === 'object' &&
          !Array.isArray(child)
        ) {
          const nested = object(child).steps;
          if (Array.isArray(nested)) visit(nested, stepPath);
        }
      }
    }
  };
  visit(rawSteps, 'steps');
  assert.deepEqual(promotionPaths, ['steps/promotion']);

  const searchIndex = rawSteps.findIndex(
    (step) =>
      step !== null &&
      typeof step === 'object' &&
      !Array.isArray(step) &&
      object(step).id === 'search',
  );
  const promotionIndex = rawSteps.findIndex(
    (step) =>
      step !== null &&
      typeof step === 'object' &&
      !Array.isArray(step) &&
      object(step).id === 'promotion',
  );
  assert.ok(searchIndex >= 0);
  assert.ok(promotionIndex > searchIndex);
});

function policyConfig(): JsonObject {
  return {
    maxRounds: 1,
    dataset: {
      trainTaskIds: ['train'],
      validationTaskIds: ['val'],
    },
  };
}

test('policy.gym-rsi promotes after search and exposes the effective candidate', async () => {
  const policy = await loadGymPolicy();
  const calls: { name: string; input: JsonObject }[] = [];
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        calls.push({ name, input });
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return {
            action: 'evaluate',
            measurementRef:
              taskId === 'train'
                ? 'm-train'
                : input.candidateRef === 'h0'
                  ? 'm-baseline'
                  : 'm-val',
          };
        }
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: true,
            candidateFeasible: true,
            selectedCandidateRef: 'c1',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation improved.',
            metric: 'successRate',
            incumbentValue: 0.5,
            candidateValue: 0.8,
            selectedValue: 0.8,
          };
        if (name === 'promotion') {
          assert.deepEqual(input, {
            action: 'promote',
            candidateRef: 'c1',
            incumbentRef: 'h0',
          });
          return {
            action: 'promote',
            decision: 'promote',
            reason: 'Candidate strictly beats incumbent on holdout.',
            promotionRef: 'artifact:promotion',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.equal(calls.at(-1)!.name, 'promotion');
  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'c1');
  assert.equal(result.candidateRef, 'c1');
  assert.equal(result.searchMeasurementRef, 'm-val');
  assert.equal(result.measurementRef, 'm-val');
  assert.equal(result.promotionDecision, 'promote');
  assert.equal(result.promotionRef, 'artifact:promotion');
});

test('policy.gym-rsi keeps the original incumbent effective when promotion is declined', async () => {
  const policy = await loadGymPolicy();
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return {
            action: 'evaluate',
            measurementRef:
              taskId === 'train'
                ? 'm-train'
                : input.candidateRef === 'h0'
                  ? 'm-baseline'
                  : 'm-val',
          };
        }
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: true,
            candidateFeasible: true,
            selectedCandidateRef: 'c1',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation improved.',
            metric: 'successRate',
            incumbentValue: 0.5,
            candidateValue: 0.8,
            selectedValue: 0.8,
          };
        if (name === 'promotion')
          return {
            action: 'promote',
            decision: 'keep-incumbent',
            reason: 'Holdout did not improve.',
            promotionRef: 'artifact:promotion',
          };
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'h0');
  assert.equal(result.candidateRef, 'h0');
  assert.equal(result.searchMeasurementRef, 'm-val');
  assert.equal(result.measurementRef, 'm-baseline');
  assert.equal(result.promotionDecision, 'keep-incumbent');
});

test('policy.gym-rsi always runs its explicit promotion step', async () => {
  const policy = await loadGymPolicy();
  const promotions: JsonObject[] = [];
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator')
          return { action: 'evaluate', measurementRef: 'm-train' };
        if (name === 'proposer')
          return {
            status: 'no-change',
            candidateRef: 'h0',
            diffRef: null,
            rationale: 'No edit.',
          };
        if (name === 'promotion') {
          promotions.push(input);
          return {
            action: 'promote',
            decision: 'keep-incumbent',
            reason: 'No candidate to promote.',
            promotionRef: 'artifact:promotion',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(promotions, [
    { action: 'promote', candidateRef: 'h0', incumbentRef: 'h0' },
  ]);
  assert.equal(result.searchCandidateRef, 'h0');
  assert.equal(result.effectiveRef, 'h0');
  assert.equal(result.promotionDecision, 'keep-incumbent');
});

test('policy.gym-rsi advances a tied candidate to holdout', async () => {
  const policy = await loadGymPolicy();
  let promotionInput: JsonObject | null = null;
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return {
            action: 'evaluate',
            measurementRef: taskId === 'train' ? 'm-train' : 'm-val',
          };
        }
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: false,
            candidateFeasible: true,
            selectedCandidateRef: 'h0',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation tied.',
            metric: 'successRate',
            incumbentValue: 1,
            candidateValue: 1,
            selectedValue: 1,
          };
        if (name === 'promotion') {
          promotionInput = input;
          return {
            action: 'promote',
            decision: 'promote',
            reason: 'Candidate beats incumbent on holdout.',
            promotionRef: 'artifact:promotion',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(promotionInput, {
    action: 'promote',
    candidateRef: 'c1',
    incumbentRef: 'h0',
  });
  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'c1');
  assert.equal(result.promotionDecision, 'promote');
});

test('policy.gym-rsi does not advance an infeasible tie to holdout', async () => {
  const policy = await loadGymPolicy();
  let promotionInput: JsonObject | null = null;
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return {
            action: 'evaluate',
            measurementRef: taskId === 'train' ? 'm-train' : 'm-val',
          };
        }
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Proposal is infeasible.',
          };
        if (name === 'selector')
          return {
            accepted: false,
            candidateFeasible: false,
            selectedCandidateRef: 'h0',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Infeasible validation tie.',
            metric: 'successRate',
            incumbentValue: 1,
            candidateValue: 1,
            selectedValue: 1,
          };
        if (name === 'promotion') {
          promotionInput = input;
          return {
            action: 'promote',
            decision: 'keep-incumbent',
            reason: 'Infeasible candidate was not advanced.',
            promotionRef: 'artifact:promotion',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(promotionInput, {
    action: 'promote',
    candidateRef: 'h0',
    incumbentRef: 'h0',
  });
  assert.equal(result.searchCandidateRef, 'h0');
  assert.equal(result.effectiveRef, 'h0');
});

test('policy.gym-rsi keeps the incumbent when validation regresses', async () => {
  const policy = await loadGymPolicy();
  let promotionInput: JsonObject | null = null;
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return {
            action: 'evaluate',
            measurementRef: taskId === 'train' ? 'm-train' : 'm-val',
          };
        }
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: false,
            candidateFeasible: true,
            selectedCandidateRef: 'h0',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation regressed.',
            metric: 'successRate',
            incumbentValue: 1,
            candidateValue: 0.8,
            selectedValue: 1,
          };
        if (name === 'promotion') {
          promotionInput = input;
          return {
            action: 'promote',
            decision: 'keep-incumbent',
            reason: 'Validation did not advance the candidate.',
            promotionRef: 'artifact:promotion',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(promotionInput, {
    action: 'promote',
    candidateRef: 'h0',
    incumbentRef: 'h0',
  });
  assert.equal(result.searchCandidateRef, 'h0');
  assert.equal(result.effectiveRef, 'h0');
  assert.equal(result.promotionDecision, 'keep-incumbent');
});

test('policy.gym-rsi rejects overlapping dataset task ids', async () => {
  const policy = await loadGymPolicy();
  await assert.rejects(
    policy.execute({
      input: { candidateRef: 'h0' },
      config: {
        maxRounds: 1,
        dataset: {
          trainTaskIds: ['same'],
          validationTaskIds: ['same'],
        },
      },
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async () => {
        throw new Error('overlapping splits must fail before invocation');
      },
    }),
    /duplicate foreach key/,
  );
});
