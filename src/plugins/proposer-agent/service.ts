import type { AgentEditingConfig } from './schema.js';
import type {
  JsonObject,
  JsonSchema,
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import {
  agentEvidencePath,
  agentInputPath,
  applyEdits,
  editEvidenceRefs,
  requestEdit,
  resourceFiles,
  validateEdits,
  type ReadOnlyEditContext,
} from '../shared/agent-editing/index.js';
import { renderTaskMessage } from '../shared/agent-editing/task-message.js';
import { proposerExecutionContext } from './execution-context.js';
import { mergeEdits } from './merge-edits.js';
import { metricEvidence } from './metric-evidence.js';
import { expandEdits, proposerEditOutputSchema } from './edits.js';
import { checkProposerAgent } from './doctor.js';

export const createProposerAgent: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  services.event?.on('rsi/doctor', checkProposerAgent);
  return {
    async execute(input, context) {
      const parent = await context.readCandidate(input.parent);
      const metadata = await context.applicationMetadata();
      const refs = editEvidenceRefs(input);
      const view = config.evidenceView ?? 'execution';
      const detailed =
        view === 'training-summary'
          ? undefined
          : proposerExecutionContext(
              object(
                await context.readEvidence(refs, { format: 'files', view }),
              ),
            );
      const evidenceContext: ReadOnlyEditContext = detailed ?? {
        files: {},
        evidence: await context.readEvidence(refs, { view }),
        input: {},
      };
      if (view !== 'execution') {
        const metricPath = 'context/metrics.json';
        // File projections resolve evidence-view references to the measurements they authorize.
        const metricRefs = detailed
          ? detailed.evidence.measurements.map((m) => string(m.measurementRef))
          : refs;
        evidenceContext.files[metricPath] = JSON.stringify(
          await metricEvidence(metricRefs, context),
        );
        evidenceContext.input.metricEvidencePath = metricPath;
        evidenceContext.input.metricEvidenceInstruction =
          'Read actual metric values, units and evaluator-provided environment summaries here before researching options. Missing metrics or environment fields are unknown; resource verification does not prove flag activation.';
      }
      const batchSchema: JsonSchema | undefined =
        input.maxCandidates === undefined
          ? undefined
          : {
              type: 'object',
              additionalProperties: false,
              required: ['proposals'],
              properties: {
                proposals: {
                  type: 'array',
                  maxItems: input.maxCandidates,
                  items: proposerEditOutputSchema,
                },
              },
            };
      const response = await requestEdit(
        config,
        { ...input, target: metadata.target },
        parent.artifactRef,
        context,
        await renderTaskMessage(
          context,
          config.messageTemplates,
          `Propose candidate improvements for the following objective:\n\n${input.goal}`,
          {
            goal: input.goal,
            inputPath: agentInputPath,
            evidencePath: agentEvidencePath,
            proposalLimit: input.maxCandidates ?? 1,
          },
        ),
        evidenceContext,
        batchSchema ?? proposerEditOutputSchema,
        config.subagents ?? [],
        true,
      );
      if (!batchSchema) return commitProposal(response);

      const candidates: Extract<
        ProposerOutput,
        { status: 'batch' }
      >['candidates'] = [];
      const noChangeReasons: string[] = [];
      for (const proposal of response.proposals as JsonObject[]) {
        const result = await commitProposal(proposal);
        if (result.status === 'created') {
          const { candidateRef, diffRef, rationale } = result;
          candidates.push({ candidateRef, diffRef, rationale });
        } else {
          noChangeReasons.push(result.rationale);
        }
      }
      if (candidates.length) return { status: 'batch', candidates };
      return {
        status: 'no-change',
        candidateRef: parent.ref,
        diffRef: null,
        rationale:
          noChangeReasons.join('\n\n') || 'No candidate changes were proposed.',
      };

      async function commitProposal(
        response: JsonObject,
      ): Promise<Exclude<ProposerOutput, { status: 'batch' }>> {
        const expanded = expandEdits(
          response,
          await context.artifacts.readJson(parent.artifactRef),
        );
        const edit = await services.workspaces.create(
          parent.artifactRef,
          parent.ref,
        );
        try {
          const constraints = input.editConstraints ?? {};
          let result = expanded.result;
          if (expanded.hasDuplicates) {
            // Check scope and raw bounds before a conflict can become a no-change.
            await validateEdits(
              edit.directory,
              result,
              context,
              constraints,
              true,
            );
            result = mergeEdits(
              result,
              await resourceFiles(parent.artifactRef, context),
            );
          }
          await applyEdits(
            edit.directory,
            result,
            context,
            constraints,
            expanded.createOnly,
          );
          const committed = await context.application({
            action: 'commit',
            parentCandidateRef: parent.ref,
            editRef: edit.ref,
            ...(input.editConstraints
              ? { editConstraints: input.editConstraints }
              : {}),
          });
          if (committed.action !== 'commit')
            throw new Error('Application did not return a commit result');
          const candidateRef = string(committed.candidateRef);
          const rationale = string(result.reason);
          if (committed.status === 'created')
            return {
              status: 'created',
              candidateRef,
              diffRef: string(committed.diffRef),
              rationale,
            };
          if (committed.status !== 'no-change' || committed.diffRef !== null)
            throw new Error('Invalid no-change Application commit output');
          return {
            status: 'no-change',
            candidateRef,
            diffRef: null,
            rationale,
          };
        } finally {
          await services.workspaces.release(edit.ref);
        }
      }
    },
    async dispose() {},
  };
};
