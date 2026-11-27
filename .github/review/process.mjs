import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export async function command(
  file,
  args,
  {
    cwd,
    env = process.env,
    input,
    timeout = 120_000,
    signal,
    discardOutput = false,
  } = {},
) {
  const abort = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([abort, signal]) : abort;
  combined.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const out = [];
    let errors = '';
    let failure;
    let terminating;
    // Codex npm launchers and Git transports own subprocesses. Wait for the
    // whole tree before removing the snapshot or starting another round.
    const stop = () => {
      if (!child.pid || terminating) return;
      if (process.platform === 'win32') {
        const taskkill = join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'taskkill.exe',
        );
        terminating = new Promise((done) =>
          execFile(
            taskkill,
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true },
            (error) => {
              if (error && child.exitCode === null) child.kill('SIGKILL');
              done();
            },
          ),
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') failure = error;
        }
      }
    };
    combined.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (bytes) => {
      if (!discardOutput) out.push(bytes);
    });
    child.stderr.on('data', (bytes) => {
      errors = (errors + bytes.toString()).slice(-2000);
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', async (status) => {
      combined.removeEventListener('abort', stop);
      await terminating;
      if (combined.aborted) reject(combined.reason);
      else if (failure) reject(failure);
      else if (status !== 0)
        reject(new Error(file + ' exited ' + status + ': ' + errors.trim()));
      else resolveCommand(Buffer.concat(out).toString());
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        failure = error;
        stop();
      }
    });
    child.stdin.end(input);
    if (combined.aborted) stop();
  });
}

export const gitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '--literal-pathspecs',
];
export const git = (cwd, args, options = {}) =>
  command('git', [...gitOptions, ...args], { cwd, ...options });

export function modelEnvironment(source, emptyGhConfig) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CODEX_HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())),
    ),
    GH_CONFIG_DIR: emptyGhConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
}

export function codexExecutable() {
  if (process.platform !== 'win32') return ['codex'];
  for (const location of (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)) {
    const native = resolve(location, 'codex.exe');
    if (existsSync(native)) return [native];
    // Resolve the official npm shim without invoking cmd.exe in a PR-controlled cwd.
    const script = join(
      location,
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (existsSync(script)) return [process.execPath, resolve(script)];
  }
  throw new Error('Codex CLI not found');
}
