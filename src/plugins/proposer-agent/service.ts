import type { AgentEditingConfig } from './schema.js';
import type {
  JsonObject,
  JsonSchema,
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { json, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import {
  applyEdits,
  editEvidenceRefs,
  requestEdit,
  resourceFiles,
  validateEdits,
  type ReadOnlyEditContext,
} from '../shared/agent-editing/index.js';
import { proposerExecutionContext } from './execution-context.js';
import { mergeEdits } from './merge-edits.js';
import { metricEvidence } from './metric-evidence.js';
import { expandEdits, proposerEditOutputSchema } from './edits.js';

export const createProposerAgent: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  return {
    async canRetry(_input, receipt, context) {
      // Agent replay is checked by its own operation. A candidate commit must
      // be reconciled separately because its workspace is specific to the attempt.
      return !(await context.facts.list('calls')).some(
        (call) =>
          call.parentCallId === receipt.callId &&
          call.bindingId === '_application',
      );
    },
    async execute(input, context) {
      json(input);
      const parent = await context.readCandidate(string(input.parent));
      const metadata = await context.applicationMetadata();
      // Runtime authorizes and sanitizes execution files before business projection.
      // Preserve the configured training-summary behavior for other Proposer users.
      let execution: ReadOnlyEditContext | undefined;
      if ((config.evidenceView ?? 'execution') === 'execution') {
        const full = object(
          await context.readEvidence(editEvidenceRefs(input), {
            format: 'files',
            view: 'execution',
          }),
        );
        execution = proposerExecutionContext(full);
      }
      if (config.evidenceView === 'training-summary') {
        execution = {
          files: {
            'context/metrics.json': JSON.stringify(
              await metricEvidence(editEvidenceRefs(input), context),
            ),
          },
          evidence: await context.readEvidence(editEvidenceRefs(input), {
            view: 'training-summary',
          }),
          input: {
            metricEvidencePath: 'context/metrics.json',
            metricEvidenceInstruction:
              'Read actual metric values and units here when previews omit them. Missing metrics are unknown, not zero.',
          },
        };
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
        execution,
        batchSchema ?? proposerEditOutputSchema,
        config.subagents ?? [],
      );
      if (!batchSchema) return commitProposal(response);

      const candidates: Extract<
        ProposerOutput,
        { status: 'batch' }
      >['candidates'] = [];
      for (const proposal of response.proposals as JsonObject[]) {
        const result = await commitProposal(proposal);
        if (result.status === 'created') {
          const { candidateRef, diffRef, rationale } = result;
          candidates.push({ candidateRef, diffRef, rationale });
        }
      }
      if (candidates.length) return { status: 'batch', candidates };
      return {
        status: 'no-change',
        candidateRef: parent.ref,
        diffRef: null,
        rationale: 'No candidate changes were proposed.',
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
          validate(
            applicationContract.output_schema,
            committed,
            'Application commit output',
          );
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
