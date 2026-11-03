import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { proposerContract, agentbenchContract } from 'ember-rsi';
import { typedArtifact } from 'ember-rsi/contracts';
const emptyConfig = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const proposer = {
  id: 'proposer.skill-fixed',
  contract: proposerContract,
  configSchema: emptyConfig,
  async create() {
    return {
      async execute(input, context) {
        context.signal.throwIfAborted();
        const parent = await context.readCandidate(input.parent);
        const workspace = await context.workspaces.create(
          parent.artifactRef,
          input.parent,
        );
        try {
          await writeFile(
            join(workspace.directory, 'prompt.md'),
            'Check the answer before returning it.\n',
          );
          const result = await context.application({
            action: 'commit',
            parentCandidateRef: input.parent,
            editRef: workspace.ref,
          });
          return {
            status: result.status,
            candidateRef: result.candidateRef,
            diffRef: result.diffRef,
            rationale: 'Deterministic demonstration edit.',
          };
        } finally {
          await context.workspaces.release(workspace.ref);
        }
      },
      async dispose() {},
    };
  },
};

// Change this ID once when copying this evaluator under a new registration name.
const evaluatorId = 'evaluator.skill-text';
const evaluatorImplementation = 'skill-text-v1';

// This evaluates a text predicate, not DSH behavior or a benchmark.
export const evaluator = {
  id: evaluatorId,
  contract: agentbenchContract,
  configSchema: emptyConfig,
  async create() {
    return {
      async execute(input, context) {
        context.signal.throwIfAborted();
        const startedAt = new Date().toISOString();
        await context.charge('evaluationRuns', 1);
        return context.withInstance(
          input.candidateRef,
          'agentbundle',
          async (execution) => {
            const content = await readFile(
              join(execution.directory, 'prompt.md'),
              'utf8',
            );
            const score = content.includes('Check the answer') ? 1 : 0;
            const rawRef = await context.artifacts.putJson({
              content,
              score,
              taskIds: input.taskIds,
            });
            const definitionRef = await context.artifacts.putJson({
              id: 'checkPhrase',
              description: 'Contains the demonstration instruction',
              unit: 'ratio',
              valueKind: 'scalar',
              version: 1,
              aggregation: 'identity',
              mapping:
                'Contains case-sensitive Check the answer => 1, otherwise 0',
            });
            const metrics = {
              checkPhrase: {
                definitionRef,
                status: 'available',
                value: { kind: 'scalar', value: score },
                source: { artifactRef: rawRef, pointer: '/score' },
              },
            };
            const evidenceIndexRef = await context.artifacts.putJson({
              schemaVersion: 'rsi.measurement-evidence/v1',
              entries: [
                {
                  id: 'prompt',
                  kind: 'trace',
                  artifactRef: rawRef,
                  mediaType: 'application/json',
                  sizeBytes: null,
                  itemId: null,
                  attemptId: null,
                  access: 'execution',
                  integrity: 'complete',
                },
              ],
            });
            const attach = async (name, value) =>
              typedArtifact(
                'skill.' + name,
                { type: 'object' },
                await context.artifacts.putJson(value),
              );
            const conditions = await attach('conditions', {
              taskIds: input.taskIds,
              evaluator: 'text-predicate-v1',
            });
            const details = await attach('details', { synthetic: true, score });
            const comparisonKey = JSON.stringify({
              evaluator: 'text-predicate-v1',
              taskIds: input.taskIds,
            });
            const itemsRef = await context.artifacts.putJson({
              schemaVersion: 'rsi.measurement-items/v1',
              items: input.taskIds.map((id) => ({
                id,
                subject: { kind: 'demonstration', id, parameters: null },
                status: 'succeeded',
                coverage: 'complete',
                comparisonKey,
                metrics,
                evaluation: null,
                evidenceIndexRef,
                details,
              })),
            });
            const measurementRef = await context.recordMeasurement({
              schemaVersion: 'rsi.measurement/v1',
              experimentId: context.experimentId,
              callId: context.callId,
              candidateRef: input.candidateRef,
              evaluator: {
                pluginId: evaluatorId,
                implementationDigest: evaluatorImplementation,
              },
              startedAt,
              finishedAt: new Date().toISOString(),
              status: 'succeeded',
              coverage: 'complete',
              comparisonKey,
              conditions,
              provenance: await attach('provenance', {
                implementation: evaluatorImplementation,
                synthetic: true,
              }),
              metrics,
              itemsRef,
              evidenceIndexRef,
              profile: await attach('profile', { synthetic: true }),
              diagnosticsRef: null,
              extensions: [],
            });
            return { measurementRef };
          },
        );
      },
      async dispose() {},
    };
  },
};
