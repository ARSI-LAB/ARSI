import type {
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/models/file-tree.js';
import type {
  InferenceTrialInput,
  InferenceTrialOutput,
} from '../../contracts/plugin-types/inference-trial.js';
import { inferencebenchContract } from '../../contracts/plugin-types/inferencebench.js';
import { InferenceStartupError } from '../../shared/errors.js';
import { canonical, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { safePath } from '../shared/file-application/target.js';

async function parameters(
  context: RuntimeContext,
  candidateRef: string,
  path: string,
): Promise<string> {
  context.signal.throwIfAborted();
  const candidate = await context.readCandidate(candidateRef);
  const tree = parseFileTree(
    await context.artifacts.readJson(candidate.artifactRef),
  );
  const file = tree.files.find((entry) => entry.path === path);
  if (!file)
    throw new Error(
      `Candidate ${candidateRef} is missing parameter file ${path}`,
    );
  return canonical(
    object(
      JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')),
      path,
    ),
  );
}

export const createInferenceTrial: OperationDefinition<
  InferenceTrialInput,
  InferenceTrialOutput
>['create'] = async () => ({
  async canRetry() {
    // The trial has no effects of its own. Manager reconciles the evaluator call.
    return true;
  },
  async execute(
    { candidateRef, evaluatorRef, deduplicate },
    context,
  ): Promise<InferenceTrialOutput> {
    if (deduplicate) {
      const path = safePath(deduplicate.parameterFile);
      const current = await parameters(context, candidateRef, path);
      for (const ref of new Set(deduplicate.candidateRefs)) {
        if (
          ref === candidateRef ||
          current === (await parameters(context, ref, path))
        )
          return {
            status: 'duplicate',
            measurementRef: null,
            reason: `Candidate parameters match ${ref}`,
          };
      }
    }
    const attempt = context.extend({
      scope: context.scope ?? {
        id: context.callId,
        signal: context.signal,
        limits: {},
      },
    });
    let measurementRef: string;
    try {
      const output = await attempt.invoke(evaluatorRef, {
        candidateRef,
        reportFailedMeasurement: true,
      });
      validate(
        inferencebenchContract.output_schema,
        output,
        'Inference evaluator output',
      );
      measurementRef = string(object(output).measurementRef);
    } catch (error) {
      if (!(error instanceof InferenceStartupError)) throw error;
      context.signal.throwIfAborted();
      return {
        status: 'startup-failed',
        measurementRef: null,
        reason: error.message,
      };
    }
    context.signal.throwIfAborted();
    const measurement = await context.readMeasurement(measurementRef);
    if (measurement.candidateRef !== candidateRef)
      throw new Error('Inference measurement belongs to another candidate');
    const { status, coverage, comparisonKey } = measurement;
    if (status === 'unknown' || status === 'cancelled')
      throw Object.assign(
        new Error(`Inference measurement status: ${status}`),
        {
          status,
          measurementRef,
        },
      );
    if (status !== 'succeeded' || coverage !== 'complete' || !comparisonKey)
      return {
        status: 'invalid-measurement',
        measurementRef,
        reason: `Inference measurement is not complete and comparable (status: ${String(status)}, coverage: ${String(coverage)})`,
      };
    return { status: 'measured', measurementRef, reason: null };
  },
  async dispose() {},
});
