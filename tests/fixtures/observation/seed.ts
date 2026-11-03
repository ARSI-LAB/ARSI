import {
  FileArtifacts,
  FileFacts,
} from '../../../src/runtime/storage/index.js';
import { join } from 'node:path';

/** Deterministic facts for HTTP and browser observation checks; no model requests. */
export async function seedObservation(
  directory: string,
): Promise<{ facts: FileFacts; artifacts: FileArtifacts }> {
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  await facts.write('experiments', 'run-alpha', {
    id: 'run-alpha',
    recipeId: 'custom-recipe',
    status: 'running',
    startedAt: '2026-10-29T01:00:00.000Z',
    recipe: {
      budget: { operations: 100, modelCalls: 20 },
      bindings: { custom: { config: { apiKey: 'fixture-private-value' } } },
    },
    output: {
      message: 'fixture-private-value',
      api_key: 'second-private-value',
    },
  });
  await facts.write('experiments', 'run-other', {
    id: 'run-other',
    recipeId: 'another-recipe',
    status: 'failed',
    startedAt: '2026-10-28T01:00:00.000Z',
    error: 'Example failure',
  });
  await facts.write('budgets', 'run-alpha', {
    operations: 12,
    modelCalls: 3,
    scopes: {},
  });
  await facts.write('calls', 'call-first', {
    callId: 'call-first',
    experimentId: 'run-alpha',
    bindingId: 'custom-binding',
    pluginId: 'unfamiliar.plugin',
    parentCallId: 'root',
    path: 'loop/0/propose',
    status: 'succeeded',
    startedAt: '2026-10-29T01:00:01.000Z',
    finishedAt: '2026-10-29T01:00:03.000Z',
    input: { prompt: 'fixture-private-value', authorization: 'private-header' },
    output: { result: 'A recorded proposal' },
  });
  await facts.write('calls', 'call-second', {
    callId: 'call-second',
    experimentId: 'run-alpha',
    bindingId: 'evaluation',
    pluginId: 'unfamiliar.evaluator',
    parentCallId: 'root',
    path: 'loop/0/evaluate',
    status: 'unknown',
    startedAt: '2026-10-29T01:00:04.000Z',
    error: 'Effects unconfirmed: fixture-private-value',
  });
  await facts.write('calls', 'call-other', {
    callId: 'call-other',
    experimentId: 'run-other',
    bindingId: 'other',
    pluginId: 'private.plugin',
    status: 'failed',
  });
  await facts.write('candidates', 'candidate-root', {
    ref: 'candidate-root',
    experimentId: 'run-alpha',
    parentRef: null,
    artifactRef: 'artifact:root',
  });
  await facts.write('candidates', 'candidate-next', {
    ref: 'candidate-next',
    experimentId: 'run-alpha',
    parentRef: 'candidate-root',
    artifactRef: 'artifact:next',
  });
  const definitionRef = await artifacts.putJson({
    id: 'quality',
    description: 'Task quality',
    unit: 'ratio',
    valueKind: 'scalar',
    version: 1,
    aggregation: 'mean',
    mapping: 'identity',
  });
  await facts.write('measurements', 'measurement-first', {
    ref: 'measurement-first',
    experimentId: 'run-alpha',
    candidateRef: 'candidate-root',
    callId: 'call-first',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: 'same-conditions',
    startedAt: '2026-10-29T01:00:01.000Z',
    finishedAt: '2026-10-29T01:00:03.000Z',
    metrics: {
      quality: {
        definitionRef,
        status: 'available',
        value: { kind: 'scalar', value: 0 },
      },
    },
  });
  await facts.write('measurements', 'measurement-second', {
    ref: 'measurement-second',
    experimentId: 'run-alpha',
    candidateRef: 'candidate-next',
    callId: 'call-second',
    status: 'unknown',
    coverage: 'partial',
    comparisonKey: null,
    startedAt: '2026-10-29T01:00:04.000Z',
    finishedAt: null,
    metrics: {
      quality: {
        definitionRef,
        status: 'unavailable',
        value: null,
        reason: 'Evaluation interrupted',
      },
    },
  });
  return { facts, artifacts };
}
