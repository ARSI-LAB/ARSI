import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const evaluatorTracerUrl = 'http://127.0.0.1:8787';

export async function startEvaluatorTracer(
  dataDirectory: string,
): Promise<void> {
  // The published Evaluator CLI lives beside its SDK entry point.
  const cli = fileURLToPath(
    new URL('./cli.js', import.meta.resolve('arsi-evaluator')),
  );
  const directory = join(dataDirectory, 'tracer');
  await promisify(execFile)(process.execPath, [
    cli,
    'tracer',
    'serve',
    '--url',
    evaluatorTracerUrl,
    '--db',
    join(directory, 'trace.db'),
    '--spool',
    join(directory, 'spool'),
  ]);
}
