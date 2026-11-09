import type { EvaluatorRunOptions } from 'ember-evaluator';
export type SdkRunOptions = EvaluatorRunOptions;
export type EvaluatorRunner = (options: SdkRunOptions) => Promise<unknown>;
export async function sdkRunner(options: SdkRunOptions): Promise<unknown> {
  const sdk = await import('ember-evaluator');
  return new sdk.Evaluator().run(options);
}
