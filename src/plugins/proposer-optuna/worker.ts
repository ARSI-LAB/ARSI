import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import type { ResolvedOptunaConfig } from './schema.js';

export type OptunaWorker = (
  config: ResolvedOptunaConfig,
  request: JsonObject,
  signal: AbortSignal,
) => Promise<JsonObject>;
export const workerPath = fileURLToPath(
  new URL('./python/worker.py', import.meta.url),
);
const maxBytes = 8 * 1024 * 1024;

/** Own a bounded one-shot child through close, including spawn failure and cancellation. */
export async function runJsonProcess(
  executable: string,
  script: string,
  request: JsonObject,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<JsonObject> {
  signal.throwIfAborted();
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > maxBytes)
    throw new Error('Optuna worker input exceeds 8 MiB');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let size = 0,
      stderr = '',
      failure: Error | undefined,
      inputFailure: Error | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = (): void =>
      stop(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Optuna worker cancelled'),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(
      () => stop(new Error('Optuna worker timeout')),
      timeoutMs,
    );
    child.once('error', (error) => {
      failure ??= error;
    });
    child.stdin.on('error', (error) => {
      inputFailure ??= error;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes)
        stop(new Error('Optuna worker output exceeds 8 MiB'));
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-65536);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Optuna worker exited ${code}: ${stderr.trim()}`));
        return;
      }
      if (inputFailure) {
        reject(inputFailure);
        return;
      }
      try {
        resolve(
          object(
            JSON.parse(Buffer.concat(output).toString('utf8')),
            'Optuna worker JSON',
          ),
        );
      } catch (error) {
        reject(
          new Error('Invalid Optuna worker JSON response', { cause: error }),
        );
      }
    });
    child.stdin.end(input);
  });
}
export const runOptunaWorker: OptunaWorker = (config, request, signal) =>
  runJsonProcess(
    config.python.executable,
    workerPath,
    request,
    signal,
    config.python.timeoutMs,
  );
