import type { DoctorContext, OperationDoctor } from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { prepareEvaluationConfig } from './service.js';

function prepareConfig(ctx: DoctorContext): SdkEvaluatorConfig {
  if (
    ['application.agentbundle', 'application.kernel'].includes(
      ctx.recipe.application.pluginId,
    )
  )
    throw new Error(
      'evaluator.inferencebench requires an Application with the inference-endpoint capability.',
    );
  const endpoint = plain(ctx.recipe.application.config.endpoint);
  const credentials = plain(ctx.recipe.application.config.credentials);
  return prepareEvaluationConfig(ctx.binding.config, {
    execution: {
      model: string(endpoint.model, 'application.config.endpoint.model'),
      baseUrl: 'http://127.0.0.1:1',
      ...(typeof credentials.apiKeyEnv === 'string'
        ? { credentialRef: credentials.apiKeyEnv }
        : {}),
    },
    directory: ctx.directory,
  });
}

export function createInferencebenchDoctor(
  run?: SdkDoctorRunner,
): OperationDoctor {
  return async (ctx) => {
    const { checks, reported } = await checkSdkDoctor(ctx, prepareConfig, run);
    if (reported)
      checks.push({
        id: 'inference-endpoint',
        status: 'unchecked',
        reason:
          'The Application creates the endpoint during execution; SDK doctor used a placeholder without establishing service readiness.',
      });
    return { checks };
  };
}

export const inferencebenchDoctor = createInferencebenchDoctor();
