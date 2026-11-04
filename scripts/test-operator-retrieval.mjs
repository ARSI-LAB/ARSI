import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(
  process.env.RSI_OPERATOR_RETRIEVAL_PYTHON ?? 'python3',
  [
    '-m',
    'unittest',
    'discover',
    '-s',
    'tests/unit',
    '-p',
    'test_operator_retrieval.py',
  ],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    timeout: 30000,
  },
);
if (result.error) throw result.error;
if (result.signal)
  throw new Error(`Operator retrieval tests terminated with ${result.signal}`);
process.exitCode = result.status ?? 1;
