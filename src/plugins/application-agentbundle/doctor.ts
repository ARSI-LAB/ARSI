import type { DoctorContext } from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';

export async function checkAgentbundleApplication(
  context: DoctorContext,
): Promise<void> {
  await checkFileApplication(context, {
    verification: 'verify-bundle',
    capability: 'agentbundle',
    entryFile: 'bundle.yaml',
  });
}
