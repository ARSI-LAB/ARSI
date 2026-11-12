import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** Wait for Windows to terminate the owned CLI and its descendants. */
export async function terminateWindowsTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.once('error', reject);
    killer.once('close', (code) => {
      // taskkill also returns failure when the process already exited.
      if (code === 0) return resolve();
      try {
        process.kill(pid, 0);
        reject(new Error('Unable to terminate the native CLI process tree.'));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
          resolve();
        else reject(error);
      }
    });
  });
}
