import { terminateWindowsTree } from './terminate.js';
import { execFileSync, spawn } from 'node:child_process';
import type { AgentProcessLauncher } from '../../../contracts/runtime/agent-execution.js';

// Darwin can report EPERM for a group containing only unreaped zombies.
function hasNoLiveGroupMembers(pgid: number): boolean {
  try {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return (
      rows.length > 0 &&
      rows.split('\n').every((row) => {
        const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(row);
        return (
          fields !== null &&
          (Number(fields[1]) !== pgid || fields[2]!.startsWith('Z'))
        );
      })
    );
  } catch {
    return false;
  }
}

/** The caller waits for process and pipe settlement before publishing any result. */
export function agentProcessLauncher(scope: {
  project: string;
  signal: AbortSignal;
}): AgentProcessLauncher {
  return async (spec, onLine) => {
    scope.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(spec.executable, spec.args, {
        cwd: scope.project,
        env: spec.env ?? process.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let failure: Error | undefined;
      let buffer = '';
      let stderr = '';
      let pending = Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals): void => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error ? error.code : undefined;
          if (code === 'ESRCH') return;
          if (
            code === 'EPERM' &&
            process.platform === 'darwin' &&
            hasNoLiveGroupMembers(child.pid)
          )
            return;
          const detail = error instanceof Error ? error.message : String(error);
          failure = Object.assign(
            new Error(
              `Agent process-group cleanup could not be confirmed (${signal}, ${code ?? 'unknown'}): ${detail}`,
              {
                cause: failure ?? error,
              },
            ),
            { status: 'unknown' },
          );
        }
      };
      let terminating: Promise<void> | undefined;
      const stop = (): void => {
        if (process.platform === 'win32') {
          if (child.pid && child.exitCode === null && child.signalCode === null)
            terminating ??= terminateWindowsTree(child.pid).catch((error) => {
              failure = Object.assign(
                new Error('Agent process-tree cleanup could not be confirmed', {
                  cause: error,
                }),
                { status: 'unknown' },
              );
              child.kill();
            });
          return;
        }
        kill('SIGTERM');
        timer ??= setTimeout(() => kill('SIGKILL'), 1000);
      };
      const consume = (line: string): void => {
        if (!line.trim()) return;
        pending = pending
          .then(async () => {
            if (failure) return;
            if (
              await onLine(line, (message) => {
                if (!scope.signal.aborted && !child.stdin.destroyed)
                  child.stdin.write(JSON.stringify(message) + '\n');
              })
            )
              child.stdin.end();
          })
          .catch((error) => {
            failure = error instanceof Error ? error : new Error(String(error));
            stop();
          });
      };
      scope.signal.addEventListener('abort', stop, { once: true });
      if (scope.signal.aborted) stop();
      child.once('error', (error) => {
        failure = error;
      });
      child.stdin.on('error', (error) => {
        if (!('code' in error) || error.code !== 'EPIPE') {
          failure = error;
          stop();
        }
      });
      // Drain diagnostics, but protocol observations alone enter the durable record.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        child.stdout.pause();
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          consume(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
        void pending.then(() => child.stdout.resume());
      });
      child.once('exit', () => {
        if (process.platform !== 'win32') kill('SIGKILL');
      });
      child.once('close', async (code, signal) => {
        consume(buffer);
        await pending;
        await terminating;
        clearTimeout(timer);
        scope.signal.removeEventListener('abort', stop);
        if (failure) reject(failure);
        else if (scope.signal.aborted) reject(scope.signal.reason);
        else if (code !== 0)
          reject(
            new Error(
              `Agent process exited with ${signal ?? code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            ),
          );
        else resolve();
      });
      if (spec.interactive) {
        child.stdin.write(
          spec.input.endsWith('\n') ? spec.input : spec.input + '\n',
        );
      } else child.stdin.end(spec.input);
    });
  };
}
