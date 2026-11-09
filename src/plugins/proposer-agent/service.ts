import type { AgentEditingConfig } from './schema.js';
import type {
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
      const response = await requestEdit(
        config,
        { ...input, target: metadata.target },
        parent.artifactRef,
        context,
        execution,
        proposerEditOutputSchema,
        config.subagents ?? [],
      );
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
    },
    async dispose() {},
  };
};
