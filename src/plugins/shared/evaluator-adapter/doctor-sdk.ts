import childProcess from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactDiagnostic } from 'ember-evaluator';

export interface SdkDoctorOptions {
  configPath: string;
  networkConfigPath: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

export type SdkDoctorRunner = (options: SdkDoctorOptions) => Promise<unknown>;

// Windows process signals terminate Node without running its SIGINT handler.
// Deliver cancellation over IPC so the public CLI can release its own resources.
const cancellationBridge = `
let pending = false;
let delivered = false;
const cancel = () => {
  if (pending && !delivered && process.listenerCount('SIGINT') > 0) {
    delivered = true;
    process.emit('SIGINT');
  }
};
process.on('message', message => {
  if (message === 'ember-rsi-doctor:cancel') { pending = true; cancel(); }
});
process.on('newListener', event => {
  if (event === 'SIGINT' && pending) queueMicrotask(cancel);
});
process.channel?.unref();
`;

/** Run the installed SDK's public CLI; the SDK owns individual probe deadlines. */
export const sdkDoctor: SdkDoctorRunner = async (options) => {
  options.signal.throwIfAborted();
  const cli = join(
    dirname(fileURLToPath(import.meta.resolve('ember-evaluator'))),
    'cli.js',
  );
  try {
    await access(cli);
  } catch {
    throw new Error(
      'The installed Evaluator SDK doctor CLI is unavailable; check the ember-evaluator installation.',
    );
  }
  const secrets = new Set(
    Object.entries(options.env).flatMap(([name, value]) =>
      value && /key|token|secret|password|credential|authorization/i.test(name)
        ? [value]
        : [],
    ),
  );
  for (const path of [options.configPath, options.networkConfigPath]) {
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return '';
      throw error;
    });
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const value = options.env[match[1]];
      if (value) secrets.add(value);
    }
  }
  options.signal.throwIfAborted();
  return new Promise<unknown>((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(cancellationBridge)}`,
        cli,
        'doctor',
        options.configPath,
        '--network',
        options.networkConfigPath,
      ],
      {
        cwd: dirname(options.configPath),
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );
    let output = '';
    let stderr = '';
    let bytes = 0;
    let failure: Error | undefined;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;
    const killTree = (): Promise<void> => {
      termination ??= new Promise<void>((done) => {
        if (!child.pid) {
          done();
          return;
        }
        if (process.platform !== 'win32') {
          const owner = child.pid;
          childProcess.execFile(
            'ps',
            ['-eo', 'pid=,ppid='],
            { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
            (error, stdout) => {
              const descendants = new Set<number>();
              if (error)
                failure ??= new Error(
                  'The Evaluator SDK doctor process tree could not be inspected before termination.',
                );
              else {
                const rows = [
                  ...stdout.matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm),
                ].map((match) => ({
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                }));
                for (let changed = true; changed; ) {
                  changed = false;
                  for (const row of rows) {
                    if (
                      row.pid !== owner &&
                      !descendants.has(row.pid) &&
                      (row.parent === owner || descendants.has(row.parent))
                    ) {
                      descendants.add(row.pid);
                      changed = true;
                    }
                  }
                }
              }
              const kill = (pid: number): void => {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch (cause) {
                  if (
                    !(
                      cause instanceof Error &&
                      'code' in cause &&
                      cause.code === 'ESRCH'
                    )
                  )
                    failure ??= new Error(
                      'The Evaluator SDK doctor process tree could not be terminated.',
                    );
                }
              };
              // SDK network commands can own detached process groups of their own.
              for (const pid of [...descendants].reverse()) {
                kill(-pid);
                kill(pid);
              }
              kill(-owner);
              done();
            },
          );
          return;
        }
        const taskkill = join(
          options.env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'taskkill.exe',
        );
        childProcess.execFile(
          taskkill,
          ['/PID', String(child.pid), '/T', '/F'],
          { timeout: 5000, windowsHide: true },
          (error) => {
            if (error && !closed) child.kill('SIGKILL');
            done();
          },
        );
      });
      return termination;
    };
    const cancel = (): void => {
      if (closed || killTimer) return;
      killTimer = setTimeout(() => {
        void killTree();
      }, 60000);
      killTimer.unref();
      try {
        child.send('ember-rsi-doctor:cancel', (error) => {
          if (error && !closed) void killTree();
        });
      } catch {
        void killTree();
      }
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) {
        failure = new Error('The Evaluator SDK doctor report exceeded 8 MiB.');
        cancel();
      } else output += chunk;
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.once('error', () => {
      failure ??= new Error(
        'The Evaluator SDK doctor process could not start.',
      );
    });
    child.once('close', async (code) => {
      closed = true;
      clearTimeout(killTimer);
      options.signal.removeEventListener('abort', cancel);
      await termination;
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 && code !== 1) {
        const detail = redactDiagnostic(
          stderr,
          [...secrets].sort((left, right) => right.length - left.length),
        )
          .trim()
          .slice(-4000);
        reject(
          new Error(
            `The Evaluator SDK doctor could not complete (exit ${code ?? 'unknown'})${detail ? `: ${detail}` : '; check the SDK configuration and runtime prerequisites.'}`,
          ),
        );
        return;
      }
      try {
        const report: unknown = JSON.parse(output);
        resolve(report);
      } catch {
        reject(
          new Error(
            'The Evaluator SDK doctor returned an invalid JSON report.',
          ),
        );
      }
    });
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
  });
};
