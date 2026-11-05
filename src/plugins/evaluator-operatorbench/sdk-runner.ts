import { EvaluatorRunError } from 'ember-evaluator';
import { sdkRunner } from '../shared/evaluator-adapter/sdk.js';
import { object } from '../../shared/json.js';
import type { PreparedSdkRun } from './sdk-configuration.js';

export async function runOperatorSdk(
  prepared: PreparedSdkRun,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return await sdkRunner({
      configPath: prepared.configPath,
      env: { ...process.env, ...prepared.env },
      signal,
    });
  } catch (error) {
    if (!(error instanceof EvaluatorRunError) || error.result === null)
      throw error;
    return {
      ...object(error.result),
      exitCode: error.exitCode,
      sdkFailure: { phase: error.phase, message: error.message },
    };
  }
}
