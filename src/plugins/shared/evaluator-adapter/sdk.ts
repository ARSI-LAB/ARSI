import type { EvaluatorRunOptions } from 'arsi-evaluator';
import { recordCleanupInput, type EvaluatorCleanupSource } from './cleanup.js';
export type SdkRunOptions = EvaluatorRunOptions;
export type EvaluatorRunner = (
  options: SdkRunOptions,
  source?: EvaluatorCleanupSource,
) => Promise<unknown>;
export async function sdkRunner(
  options: SdkRunOptions,
  source?: EvaluatorCleanupSource,
): Promise<unknown> {
  const sdk = await import('arsi-evaluator');
  if (source)
    await recordCleanupInput(
      source,
      options.configPath,
      options.env ?? process.env,
    );
  return new sdk.Evaluator().run(options);
}
