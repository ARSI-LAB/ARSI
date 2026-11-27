import type { AgentEditingConfig } from './schema.js';
import type {
  AgentInput,
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { digest } from '../../shared/json.js';
import {
  loadAgentPrompt,
  operationSchema,
} from '../shared/agent-editing/index.js';
import { prepareAgentProject } from '../shared/agent-editing/project.js';
import { agentEditorDoctorRules } from '../shared/agent-editing/doctor.js';
import { renderTaskMessage } from '../shared/agent-editing/task-message.js';

export const createArtifactSelector: OperationDefinition<
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  services.event?.on('rsi/doctor', (request) =>
    agentEditorDoctorRules(request),
  );
  return {
    async execute(input, context) {
      const candidatesPath = 'context/candidates.json';
      const message = await renderTaskMessage(
        context,
        config.messageTemplates,
        `Compare the anonymized candidate deliverables in ${candidatesPath} using this rubric:\n\n${input.rubric}`,
        {
          rubric: input.rubric,
          candidateCount: input.candidates.length,
          candidatesPath,
        },
      );
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
          delivery: await context.readEvidence([c.measurementRef], {
            view: 'delivery',
          }),
        })),
      );
      const prompt = await loadAgentPrompt(config);
      const cwd = await prepareAgentProject(
        context,
        `${prompt}\n\nRead ${candidatesPath} for the anonymized candidate views. Each entry has a numeric label and its delivery evidence.`,
        { [candidatesPath]: JSON.stringify(views, null, 2) },
        config.skills ?? [],
        [],
      );
      const request: AgentInput = {
        message,
        cwd,
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
      };
      const result = await context.invokeAgent(
        config.agentRef ?? 'agent.default',
        request,
      );
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
