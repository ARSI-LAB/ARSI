import { readFile } from 'node:fs/promises';
export interface SdkRunOptions {
  configPath: string;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  resume?: boolean | string;
}
export type EvaluatorRunner = (options: SdkRunOptions) => Promise<unknown>;
export async function sdkRunner(options: SdkRunOptions): Promise<unknown> {
  const sdk = await import('ember-evaluator');
  sdk.parseUserConfig(JSON.parse(await readFile(options.configPath, 'utf8')));
  return new sdk.Evaluator().run(options);
}
