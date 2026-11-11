import type { DoctorContext } from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';

export async function checkKernelApplication(
  context: DoctorContext,
): Promise<void> {
  await checkFileApplication(context, {
    verification: 'verify-source',
    capability: 'kernel-source',
    entryFile: 'input.py',
  });
}
