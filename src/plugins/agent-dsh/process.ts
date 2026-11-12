import { spawn } from 'node:child_process';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import { terminateWindowsTree } from '../shared/native-agent/terminate.js';

/** Own the CLI process group, including descendants, until its pipes close. */
export async function runDshProcess(
  executable: string,
  cwd: string,
  patch: string,
  prompt: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  const launch = await nativeAgentCommand(executable);
  signal.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const child = spawn(
      launch.command,
      [
        ...launch.args,
        '--profile',
        'headless',
        '--patch',
        patch,
        '--json',
        '--permission-mode',
        'read-only',
        '--approval-policy',
        'never',
        '-',
      ],
      {
        cwd,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let failure: unknown;
    let buffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminating: Promise<void> | undefined;
    const terminate = (value: NodeJS.Signals): void => {
      if (process.platform === 'win32') {
        if (child.pid)
          terminating ??= terminateWindowsTree(child.pid).catch(
            (error: unknown) => {
              failure ??= error;
              child.kill('SIGKILL');
            },
          );
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, value);
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
    // stderr can contain model text, provider credentials and local configuration.
    // Do not copy it into RSI errors or diagnostics.
    child.stderr.resume();
    child.stdin.on('error', (error) => {
      if (!('code' in error) || error.code !== 'EPIPE') {
        failure = error;
        cancel();
      }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure || signal.aborted) return;
      try {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) onLine(line);
        }
        if (buffer.length > 16 * 1024 * 1024)
          throw new Error('DSH output line exceeds 16 MiB');
      } catch (error) {
        failure = error;
        cancel();
      }
    });
    child.once('exit', () => {
      if (process.platform !== 'win32') terminate('SIGKILL');
    });
    child.once('close', async (code, exitSignal) => {
      await terminating;
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      try {
        if (signal.aborted) throw signal.reason;
        if (failure) throw failure;
        if (code !== 0)
          throw new Error(
            `DSH process exited with code ${code} (signal ${exitSignal ?? 'none'}); inspect native DSH logs`,
          );
        if (buffer.trim()) onLine(buffer);
        done();
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}
