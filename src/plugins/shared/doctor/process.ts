import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentLineHandler } from '../../../contracts/index.js';

/** No shell expansion. Abort kills the probe and waits for its exit before returning. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    signal: AbortSignal;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    onLine?: AgentLineHandler;
    acceptedExitCodes?: readonly number[];
  },
): Promise<{ stdout: string; stderr: string }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let pending = Promise.resolve();
    let lineBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let completed = false;
    let failure: Error | undefined;
    let terminating: Promise<void> | undefined;
    const kill = (): void => {
      if (terminating) return;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            failure = error instanceof Error ? error : new Error(String(error));
        }
      } else if (child.pid) {
        terminating = new Promise<void>((done) => {
          const taskkill = spawn(
            join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'taskkill.exe',
            ),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' },
          );
          taskkill.once('error', (error) => {
            failure = error;
            child.kill('SIGKILL');
          });
          taskkill.once('close', () => done());
        });
      }
    };
    const handleLine = (line: string): void => {
      pending = pending
        .then(async () => {
          if (failure || options.signal.aborted || completed) return;
          const done = await options.onLine!(line, (message) => {
            child.stdin.write(JSON.stringify(message) + '\n');
          });
          if (done) {
            completed = true;
            child.stdin.end();
          }
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          kill();
        });
    };
    const collect = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const decoded =
        stream === 'stdout'
          ? stdoutDecoder.write(data)
          : stderrDecoder.write(data);
      if (stream === 'stdout') stdout += decoded;
      else stderr += decoded;
      if (stdout.length + stderr.length > 1024 * 1024) {
        failure = new Error(`${command}: probe output exceeded 1 MiB`);
        kill();
      }
      if (stream === 'stdout' && options.onLine) {
        lineBuffer += decoded;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop()!;
        for (const line of lines) handleLine(line);
      }
    };
    options.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (data: Buffer) => collect('stdout', data));
    child.stderr.on('data', (data: Buffer) => collect('stderr', data));
    child.stdin.on('error', (error: Error) => {
      if ('code' in error && error.code === 'EPIPE') return;
      failure = error;
      kill();
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', async (code) => {
      options.signal.removeEventListener('abort', kill);
      const remainder = stdoutDecoder.end();
      stdout += remainder;
      stderr += stderrDecoder.end();
      if (options.onLine && (lineBuffer || remainder))
        handleLine(lineBuffer + remainder);
      await pending;
      await terminating;
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else if (
        code === null ||
        !(options.acceptedExitCodes ?? [0]).includes(code)
      )
        reject(
          new Error(
            `${command} exited ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      else resolve({ stdout, stderr });
    });
    if (options.onLine) child.stdin.write(options.input ?? '');
    else child.stdin.end(options.input);
    if (options.signal.aborted) kill();
  });
}
