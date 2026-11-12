import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { parseDocument } from 'yaml';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import {
  checkNativeAgent,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkDshAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const result = await checkNativeAgent(
    context,
    'dsh',
    ['--profile', 'headless', '--help'],
    ['--json', '--permission-mode', '--approval-policy'],
  );
  if (result.checks[0].status !== 'passed') return result;
  result.checks.splice(
    1,
    0,
    await runDoctorCheck(
      'profile-config',
      async (signal) => {
        const stdout = await runNativeAgentCommand(
          context,
          'dsh',
          ['--profile', 'headless', '--dump-config'],
          signal,
        );
        // Keep native expressions inert, and never include dump values or parser errors in diagnostics.
        const document = parseDocument(stdout, { logLevel: 'silent' });
        if (document.errors.length)
          throw new Error('DSH returned invalid headless configuration.');
        let value: unknown;
        try {
          value = document.toJS();
        } catch {
          throw new Error('DSH returned unsupported headless configuration.');
        }
        if (!Array.isArray(value) || value.length === 0)
          throw new Error(
            'DSH returned an empty or unsupported headless configuration.',
          );
      },
      { signal: context.signal },
    ),
  );
  result.checks.splice(2, 0, {
    id: 'doctor',
    status: 'unchecked',
    reason:
      'This DSH adapter has no native machine-readable health report. Configuration composition does not validate runtime model routes or stored credentials.',
  });
  return result;
}
