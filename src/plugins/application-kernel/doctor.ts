import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';

export async function checkKernelApplication(
  context: DoctorContext,
): Promise<DoctorResult> {
  return checkFileApplication(context, {
    verification: 'verify-source',
    capability: 'kernel-source',
    entryFile: 'input.py',
  });
}
