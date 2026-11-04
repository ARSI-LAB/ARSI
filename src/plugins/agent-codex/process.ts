import { spawn } from 'node:child_process';
import { codexCommand } from './executable.js';

/** Own the entire process group until exit, including cancellation and launch errors. */
export async function runCodexProcess(
  executable: string,
  directory: string,
  args: string[],
  input: string,
  signal: AbortSignal,
  onLine?: (line: string, send: (message: unknown) => void) => void | boolean,
): Promise<void> {
  signal.throwIfAborted();
  const command = codexCommand(executable);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, ...args], {
      cwd: directory,
      detached: process.platform !== 'win32',
      // Codex owns local authentication, credential refresh and provider environment references.
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    let failure: unknown;
    let buffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        )
          failure ??= error;
      }
    };
    const cancel = (): void => {
      terminate('SIGTERM');
      killTimer ??= setTimeout(() => terminate('SIGKILL'), 1000);
      killTimer.unref();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.once('error', (error) => {
      failure = error;
    });
    child.stdin.on('error', () => {
      /* Exit status reports an early stdin close. */
    });
    child.stdout.on('data', (chunk: string) => {
      if (!onLine || failure) return;
      try {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024)
          throw new Error('Codex protocol exceeds byte limit');
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim())
            if (
              onLine(line, (message) =>
                child.stdin.write(JSON.stringify(message) + '\n'),
              )
            )
              child.stdin.end();
        }
      } catch (error) {
        failure = error;
        cancel();
      }
    });
    child.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`Codex process exited with code ${code}`));
      else resolve();
    });
    if (onLine) child.stdin.write(input);
    else child.stdin.end(input);
  });
}
