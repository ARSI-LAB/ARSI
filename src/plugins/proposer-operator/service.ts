import {
  type Candidate,
  type JsonObject,
  type OperationDefinition,
  type OperatorProposerInput,
  type OperatorProposerOutput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import { operatorProposerContract } from '../../contracts/plugin-types/proposer-operator.js';
import { string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { literalPathPattern } from '../shared/file-application/target.js';
import { applyEdits } from '../shared/agent-editing/index.js';
import {
  operatorEditOutputSchema,
  type OperatorProposerConfig,
  configSchema,
  type AnalysisReceipt,
} from './schema.js';
import {
  readOperatorCandidate,
  readOperatorArtifact,
  readAssessment,
  operatorScalar,
  assertOperatorConditions,
} from '../shared/operator-attempt/service.js';
import {
  OperatorModelOutputError,
  requestOperatorAgent,
} from '../shared/operator-attempt/agent.js';
import { readHardwareContext, loadOperatorResources } from './resources.js';
import { operatorSnapshot } from './source-snapshot.js';
import { prepareStatic } from './static-analysis.js';
import { prepareMetrics } from './metrics-analysis.js';

async function commitOperatorEdits(
  response: JsonObject,
  parent: Candidate,
  analysisRef: string,
  action: 'propose' | 'repair',
  editConstraints: JsonObject,
  context: RuntimeContext,
  services: RuntimeContext,
): Promise<OperatorProposerOutput> {
  const workspace = await services.workspaces.create(
    parent.artifactRef,
    parent.ref,
  );
  try {
    await applyEdits(workspace.directory, response, context, editConstraints);
    const result = await context.application({
      action: 'commit',
      parentCandidateRef: parent.ref,
      editRef: workspace.ref,
      editConstraints,
    });
    validate(
      applicationContract.output_schema,
      result,
      'Operator candidate commit',
    );
    if (result.action !== 'commit')
      throw new Error('Operator Application did not commit');
    const candidateRef = string(result.candidateRef);
    const rationale = string(response.reason);
    if (result.status === 'created')
      return {
        action,
        status: 'created',
        candidateRef,
        diffRef: string(result.diffRef),
        rationale,
        analysisRef,
        reasonCode: 'created',
      };
    if (
      result.status !== 'no-change' ||
      result.diffRef !== null ||
      candidateRef !== parent.ref
    )
      throw new Error('Invalid operator no-change commit');
    return {
      action,
      status: 'no-change',
      candidateRef,
      diffRef: null,
      rationale,
      analysisRef,
      reasonCode: 'no-supported-change',
    };
  } finally {
    await services.workspaces.release(workspace.ref);
  }
}

async function assertRepair(
  failed: Candidate,
  rootRef: string,
  repairIndex: number,
  baseline: JsonObject,
  measured: JsonObject,
  context: RuntimeContext,
): Promise<void> {
  if (operatorScalar(measured, 'candidateValid') !== 0)
    throw new Error('Operator repair requires a confirmed candidate failure');
  assertOperatorConditions(
    await readOperatorArtifact(baseline, 'conditions', context),
    await readOperatorArtifact(measured, 'conditions', context),
  );
  let cursor = failed;
  for (let depth = 0; depth < repairIndex; depth++) {
    if (cursor.parentRef === null)
      throw new Error('Operator repair ancestry mismatch');
    cursor = await readOperatorCandidate(cursor.parentRef, context);
  }
  if (cursor.ref !== rootRef)
    throw new Error('Operator repair index does not match parent chain');
}

async function proposalFailure(
  input: OperatorProposerInput,
  parentRef: string,
  analysisRef: string,
  error: Error,
  context: RuntimeContext,
): Promise<OperatorProposerOutput> {
  const errorRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.operator-model-error/v1',
    experimentId: context.experimentId,
    phase: input.phase,
    ...(input.phase === 'static'
      ? { attempt: input.attempt }
      : { round: input.round }),
    stage: input.action,
    message: error.message,
  });
  return {
    action: input.action,
    status: 'failed',
    candidateRef: parentRef,
    diffRef: null,
    analysisRef,
    errorRef,
    reasonCode: 'invalid-model-output',
    rationale: error.message,
  };
}

export const createOperatorProposer: OperationDefinition<
  OperatorProposerInput,
  OperatorProposerOutput,
  OperatorProposerConfig
>['create'] = async (rawConfig, services) => {
  const config = parseConfig<OperatorProposerConfig>(
    configSchema,
    rawConfig,
    'Operator Proposer config',
  );
  const hardware =
    config.hardwareContextFile === undefined
      ? null
      : await readHardwareContext(config.hardwareContextFile);
  return {
    async execute(input, context) {
      validate(
        operatorProposerContract.input_schema,
        input,
        'Operator Proposer input',
      );
      context.signal.throwIfAborted();
      const loaded = await loadOperatorResources(config);
      const receipt: AnalysisReceipt = {
        analysisRef:
          input.action === 'propose' && input.phase === 'metrics'
            ? null
            : input.analysisRef,
      };
      try {
        const prepared =
          input.phase === 'static'
            ? await prepareStatic(
                config,
                hardware,
                input,
                context,
                loaded,
                receipt,
              )
            : await prepareMetrics(
                config,
                hardware,
                input,
                context,
                loaded,
                receipt,
              );
        if (input.action === 'propose' && prepared.noStaticIssues)
          return {
            action: 'propose',
            status: 'no-change',
            candidateRef: prepared.parent.ref,
            diffRef: null,
            rationale: 'No supported static issues were diagnosed.',
            analysisRef: prepared.analysisRef,
            reasonCode: 'no-static-issues',
          };
        let parent = prepared.parent;
        if (input.action === 'repair') {
          parent = await readOperatorCandidate(
            input.failedCandidateRef,
            context,
          );
          await assertRepair(
            parent,
            prepared.parent.ref,
            input.repairIndex,
            prepared.baseline,
            await readAssessment(input.measurementRef, parent.ref, context),
            context,
          );
        }
        const stage = input.action === 'propose' ? 'generate' : 'repair';
        const snapshot = await operatorSnapshot(
          parent,
          config,
          prepared.baseline,
          context,
        );
        const editablePaths = snapshot.editablePaths;
        if (!editablePaths.length)
          throw new Error('Kernel Target permits no source modifications');
        const editConstraints = {
          allowedPaths: editablePaths.map(literalPathPattern),
          maxChangedFiles: editablePaths.length,
        };
        const outputSchema = operatorEditOutputSchema(editablePaths);
        const response = await requestOperatorAgent(
          stage,
          config.agentRef,
          {
            goal: input.goal,
            prompt:
              (stage === 'generate'
                ? prepared.generatePrompt
                : loaded.prompts.repair) +
              '\n\n' +
              loaded.guidelines,
            ...snapshot,
            input: {
              stage,
              ...prepared.generationContext,
              evidence:
                input.action === 'repair'
                  ? await context.readEvidence([input.measurementRef], {
                      view: 'training-summary',
                    })
                  : null,
              target: (await context.applicationMetadata()).target ?? null,
              editConstraints,
            },
            outputSchema,
          },
          context,
          config.modelRequestTimeoutMs,
        );
        return await commitOperatorEdits(
          response,
          parent,
          prepared.analysisRef,
          input.action,
          editConstraints,
          context,
          services,
        );
      } catch (error) {
        if (
          !(error instanceof OperatorModelOutputError) ||
          receipt.analysisRef === null
        )
          throw error;
        return proposalFailure(
          input,
          input.action === 'repair'
            ? input.failedCandidateRef
            : input.phase === 'static'
              ? input.entryCandidateRef
              : input.parentCandidateRef,
          receipt.analysisRef,
          error,
          context,
        );
      }
    },
    async dispose() {},
  };
};
