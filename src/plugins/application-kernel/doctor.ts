import type {
  DoctorContext,
  DoctorRule,
  Operation,
} from '../../contracts/index.js';
import { fileApplicationDoctorRules } from '../shared/file-application/doctor.js';
import { kernelSourcePath } from '../shared/kernel-execution.js';

export function checkKernelApplication(
  context: DoctorContext,
  operation: Operation,
): DoctorRule[] {
  return fileApplicationDoctorRules(context, operation, {
    verification: 'verify-source',
    capability: 'kernel-source',
    entryFile: kernelSourcePath(context.binding.config.entryFile),
  });
}
