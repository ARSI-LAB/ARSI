import type { AgentEditingConfig } from './schema.js';
import type {
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { json, object, string } from '../../shared/json.js';
import {
  commitEdits,
  editEvidenceRefs,
  requestEdit,
  resourceFiles,
  validateEdits,
  type ReadOnlyEditContext,
} from '../shared/agent-editing/index.js';
import { proposerExecutionContext } from './execution-context.js';
import { mergeEdits } from './merge-edits.js';

export const createProposerAgent: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  return {
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
      );
      const edit = await services.workspaces.create(
        parent.artifactRef,
        parent.ref,
      );
      try {
        const constraints = input.editConstraints ?? {};
        // Check scope and raw bounds before a conflict can become a no-change.
        await validateEdits(
          edit.directory,
          response,
          context,
          constraints,
          true,
        );
        const result = mergeEdits(
          response,
          await resourceFiles(parent.artifactRef, context),
        );
        const committed = await commitEdits(
          edit,
          result,
          parent.ref,
          context,
          input.editConstraints,
        );
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
