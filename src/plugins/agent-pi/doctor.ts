import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { probeModelAccess, type ModelAccessResult } from './model-access.js';
import { resolveModelConfig } from './service.js';

export async function checkPiAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const options = { signal: context.signal };
  let resolved: ReturnType<typeof resolveModelConfig> | undefined;
  const configured = await runDoctorCheck(
    'model-config',
    async (signal) => {
      const config = context.binding.config;
      const operation = await context.binding.definition.create(
        config,
        context.runtime.extend({ signal }),
      );
      try {
        resolved = resolveModelConfig(config);
        let url: URL;
        try {
          url = new URL(resolved.base_url);
        } catch {
          throw new Error(
            'agent.pi base_url must resolve to an HTTP(S) endpoint',
          );
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new Error(
            'agent.pi base_url must resolve to a credential-free HTTP(S) endpoint',
          );
        }
      } finally {
        await operation.dispose();
      }
    },
    options,
  );
  if (configured.status !== 'passed' || !resolved) {
    return {
      checks: [
        configured,
        {
          id: 'model-access',
          status: 'unchecked',
          reason:
            'Proposal model access was not checked because agent.pi model configuration is invalid.',
        },
      ],
    };
  }
  const model = resolved;
  let access: ModelAccessResult | undefined;
  const checked = await runDoctorCheck(
    'model-access',
    async (signal) => {
      access = await probeModelAccess(
        {
          side: 'Proposal',
          model: model.model,
          baseUrl: model.base_url,
          apiKey: model.api_key,
        },
        signal,
      );
    },
    options,
  );
  return {
    checks: [
      configured,
      checked.status === 'passed' && access
        ? { id: checked.id, ...access }
        : checked,
    ],
  };
}
