import type { DoctorContext, JsonObject } from '../../contracts/index.js';
import { probeModelAccess } from './model-access.js';
import { resolveModelConfig } from './service.js';

export async function checkPiAgent(context: DoctorContext): Promise<void> {
  const configured = await context.check('model-config', async () => {
    const config = context.binding.config;
    const operation = await context.binding.definition.create(
      config,
      context.runtime,
    );
    try {
      const resolved = resolveModelConfig(config);
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
      )
        throw new Error(
          'agent.pi base_url must resolve to a credential-free HTTP(S) endpoint',
        );
    } finally {
      await operation.dispose();
    }
  });
  if (!configured) {
    context.unchecked(
      'model-access',
      'Proposal model access was not checked because agent.pi model configuration is invalid.',
    );
    return;
  }
  const options: { reason?: string; details: JsonObject } = { details: {} };
  await context.check(
    'model-access',
    async (signal) => {
      const resolved = resolveModelConfig(context.binding.config);
      const result = await probeModelAccess(
        {
          side: 'Proposal',
          model: resolved.model,
          baseUrl: resolved.base_url,
          apiKey: resolved.api_key,
        },
        signal,
      );
      options.reason = result.reason;
      options.details = result.details;
      if (result.status === 'failed') throw new Error(result.reason);
    },
    options,
  );
}
