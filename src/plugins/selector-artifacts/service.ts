import type { AgentEditingConfig } from './schema.js';
import type {
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  JsonObject,
  OperationDefinition,
} from '../../contracts/index.js';
import { digest, json, string } from '../../shared/json.js';
import {
  loadAgentPrompt,
  operationSchema,
} from '../shared/agent-editing/index.js';

export const createArtifactSelector: OperationDefinition<
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  return {
    async execute(input, context) {
      json(input);
      if (!Array.isArray(input.candidates) || !input.candidates.length)
        throw new Error('No selection candidates');
      const candidates = input.candidates
        .map((candidate, index) => ({
          ...candidate,
          originalIndex: index,
        }))
        .sort((a, b) =>
          digest({
            callId: context.callId,
            index: a.originalIndex,
          }).localeCompare(
            digest({ callId: context.callId, index: b.originalIndex }),
          ),
        );
      const views = await Promise.all(
        candidates.map(async (c, index) => ({
          label: index,
          delivery: await context.readEvidence([string(c.measurementRef)], {
            view: 'delivery',
          }),
        })),
      );
      const prompt = await loadAgentPrompt(config);
      const request: JsonObject = {
        goal: string(input.rubric),
        prompt,
        agentRef: config.agentRef ?? 'agent.default',
        input: { candidates: views },
        files: {},
        outputSchema: operationSchema(
          {
            selectedIndex: {
              type: 'integer',
              minimum: 0,
              maximum: candidates.length - 1,
            },
            reason: { type: 'string' },
          },
          ['selectedIndex', 'reason'],
        ),
        maxModelCalls: config.maxModelCalls ?? 4,
      };
      const result = await context.invokeAgent(request);
      const selected = candidates[Number(result.selectedIndex)];
      if (!selected) throw new Error('Invalid selected index');
      const decisionRef = await services.artifacts.putJson({
        kind: 'artifact-decision',
        candidates: candidates.map((candidate) => ({
          candidateRef: candidate.candidateRef,
          measurementRef: candidate.measurementRef,
          originalIndex: candidate.originalIndex,
        })),
        selectedIndex: result.selectedIndex,
        reason: result.reason,
      });
      return {
        candidateRef: selected.candidateRef,
        measurementRef: selected.measurementRef,
        decisionRef,
      };
    },
    async dispose() {},
  };
};
