import { spawn } from 'node:child_process';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import { terminateWindowsTree } from '../shared/native-agent/terminate.js';

/** Own the CLI and its descendants until completion, failure, or cancellation. */
export async function runClaudeProcess(
  executable: string,
  args: string[],
  directory: string,
  input: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  const launch = await nativeAgentCommand(executable);
  signal.throwIfAborted();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], {
      cwd: directory,
      env: process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: unknown;
    let buffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminating: Promise<void> | undefined;
    const terminate = (kind: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        terminating ??= terminateWindowsTree(child.pid).catch(
          (error: unknown) => {
            failure ??= error;
            child.kill('SIGKILL');
          },
        );
        return;
      }
      try {
        process.kill(-child.pid, kind);
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        )
          failure ??= error;
      }
    };
    const stop = (): void => {
      terminate('SIGTERM');
      killTimer ??= setTimeout(() => terminate('SIGKILL'), 1000);
    };
    const consume = (line: string): void => {
      if (!line.trim() || failure || signal.aborted) return;
      try {
        onLine(line);
      } catch (error) {
        failure = error;
        stop();
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', (error) => {
      failure = error;
    });
    child.stdin.on('error', () => {
      /* Early exits are checked below. */
    });
    // Native stderr may contain credentials or provider response bodies.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure || signal.aborted) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) {
          failure = new Error('Claude Code event exceeds 16 MiB');
          stop();
          return;
        }
        consume(line);
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        failure = new Error('Claude Code event exceeds 16 MiB');
        stop();
      }
    });
    // Descendants must not keep stdio open after the CLI exits.
    child.once('exit', stop);
    child.once('close', async (code, exitSignal) => {
      consume(buffer);
      terminate('SIGKILL');
      await terminating;
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `Claude Code exited with ${exitSignal ?? code}; check authentication and CLI configuration`,
          ),
        );
      else resolvePromise();
    });
    child.stdin.end(input);
  });
}
