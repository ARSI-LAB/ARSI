import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { EmbeddingConfig } from './schema.js';

const CLEANUP_GRACE_MS = 1000;
const ERROR_MESSAGE_TAIL_BYTES = 16 * 1024;

async function groupHasLiveProcesses(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const id of await readdir('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        const raw = await readFile(`/proc/${id}/stat`, 'utf8');
        const parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (Number(parts[2]) === pid && !['Z', 'X'].includes(parts[0]!))
          return true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['ENOENT', 'ESRCH', 'EACCES'].includes(String(error.code))
          )
        )
          throw error;
      }
    }
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

async function waitForGroupExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + CLEANUP_GRACE_MS;
  while (await groupHasLiveProcesses(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

function captureLog(
  stream: Readable,
  path: string,
  name: 'output' | 'error',
  maxBytes?: number,
): Promise<void> {
  return pipeline(
    stream,
    async function* (chunks) {
      let written = 0;
      for await (const chunk of chunks) {
        if (maxBytes !== undefined && written + chunk.length > maxBytes)
          throw new Error(
            `Retrieval worker ${name} log exceeds maxLogBytes (${maxBytes})`,
          );
        written += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(path),
  );
}

async function stderrDiagnostic(path: string): Promise<string> {
  const { size } = await stat(path);
  if (size === 0) return '';
  const start = Math.max(0, size - ERROR_MESSAGE_TAIL_BYTES);
  const tail = (
    await text(createReadStream(path, { start, end: size - 1 }))
  ).trim();
  return start === 0 ? tail : `[truncated; full stderr: ${path}]\n${tail}`;
}

/** Stop the process group at root exit before draining pipes inherited by its descendants. */
export async function runRetrievalWorker(
  config: EmbeddingConfig,
  args: string[],
  cwd: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === 'win32')
    throw new Error('Operator retrieval requires POSIX process-group cleanup');
  const child = spawn(config.python, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CUDA_VISIBLE_DEVICES: '',
      ASCEND_RT_VISIBLE_DEVICES: '',
      HIP_VISIBLE_DEVICES: '',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HOME: join(cwd, 'hf-cache'),
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  let failure: Error | undefined;
  let cleanupError: Error | undefined;
  let releaseRootWait: (() => void) | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  const abandonOpenPipes = (): void => {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream.readableEnded || stream.destroyed) continue;
      cleanupError ??= new Error(
        'Retrieval worker cleanup unknown: log pipe remained open',
        { cause: failure },
      );
      stream.destroy();
    }
  };
  const schedulePipeCleanup = (): void => {
    // Stop waiting for escaped writers. Give buffered output an extra drain window;
    // finished inputs can always flush their pending file writes to completion.
    drainTimer ??= setTimeout(() => {
      if (child.stdout.readableLength || child.stderr.readableLength)
        drainTimer = setTimeout(abandonOpenPipes, CLEANUP_GRACE_MS);
      else abandonOpenPipes();
    }, CLEANUP_GRACE_MS);
  };
  let groupSignalled = false;
  const killGroup = (): void => {
    if (groupSignalled || child.pid === undefined) return;
    groupSignalled = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        return;
      cleanupError = new Error('Retrieval worker cleanup failed', {
        cause: error,
      });
      child.unref();
      releaseRootWait?.();
      abandonOpenPipes();
    }
  };
  const stop = (error: Error): void => {
    failure ??= error;
    killGroup();
    schedulePipeCleanup();
  };
  const exited = new Promise<number | null>((resolve) => {
    releaseRootWait = () => resolve(child.exitCode);
    child.once('exit', resolve);
    child.once('error', (error) => {
      stop(error);
      resolve(child.exitCode);
    });
  });
  const abort = (): void =>
    stop(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Retrieval worker cancelled'),
    );
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer =
    config.timeoutMs > 0
      ? setTimeout(
          () => stop(new Error('Retrieval worker timeout')),
          config.timeoutMs,
        )
      : undefined;

  const stderrPath = join(directory, 'stderr.log');
  const logs = Promise.all([
    captureLog(
      child.stdout,
      join(directory, 'stdout.log'),
      'output',
      config.maxLogBytes,
    ).catch(stop),
    captureLog(child.stderr, stderrPath, 'error', config.maxLogBytes).catch(
      stop,
    ),
  ]);
  try {
    const code = await exited;
    killGroup();
    schedulePipeCleanup();
    const verifyCleanup = async (): Promise<boolean> => {
      try {
        if (child.pid === undefined || (await waitForGroupExit(child.pid)))
          return true;
      } catch (error) {
        cleanupError = new Error('Retrieval worker cleanup failed', {
          cause: error,
        });
      }
      abandonOpenPipes();
      return false;
    };
    const [cleaned] = await Promise.all([
      verifyCleanup(),
      logs.finally(() => clearTimeout(timer)),
    ]);
    await writeFile(
      join(directory, 'process.json'),
      JSON.stringify({
        pid: child.pid ?? null,
        exitCode: code,
        cleanup: cleaned && !cleanupError ? 'confirmed' : 'unknown',
        error: (cleanupError ?? failure)?.message ?? null,
      }) + '\n',
    );
    if (cleanupError) throw cleanupError;
    if (!cleaned) throw new Error('Retrieval worker cleanup unknown');
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        `Retrieval worker exited ${code ?? child.signalCode}: ${await stderrDiagnostic(stderrPath)}`,
      );
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
    signal.removeEventListener('abort', abort);
  }
}
