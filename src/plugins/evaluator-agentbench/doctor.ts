import { join } from 'node:path';
import type {
  DoctorContext,
  JsonValue,
  OperationDoctor,
} from '../../contracts/index.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { prepareEvaluationConfig } from './service.js';

function taskIds(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(taskIds);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) =>
      /taskIds$/i.test(key) && Array.isArray(entry)
        ? entry.filter((item): item is string => typeof item === 'string')
        : taskIds(entry),
    );
  return [];
}

async function bundleDirectory(ctx: DoctorContext): Promise<string> {
  const baseline = plain(ctx.recipe.application.config.baseline);
  if (typeof baseline.directory === 'string') return baseline.directory;
  if (typeof baseline.artifactRef === 'string') {
    const directory = join(ctx.directory, 'baseline');
    await ctx.runtime.artifacts.materialize(baseline.artifactRef, directory);
    return directory;
  }
  ctx.unchecked(
    'application-instance',
    'The Application supplies its instance during execution; SDK doctor uses a temporary path without establishing instance readiness.',
  );
  return ctx.directory;
}

async function prepareConfig(ctx: DoctorContext): Promise<SdkEvaluatorConfig> {
  if (
    ['application.inference', 'application.kernel'].includes(
      ctx.recipe.application.pluginId,
    )
  )
    throw new Error(
      'evaluator.agentbench requires an Application with the agentbundle capability.',
    );
  return prepareEvaluationConfig(ctx.binding.config, {
    taskIds: [...new Set(taskIds(ctx.recipe.policyConfig))],
    execution: { directory: await bundleDirectory(ctx) },
    directory: ctx.directory,
  });
}

export function createAgentbenchDoctor(run?: SdkDoctorRunner): OperationDoctor {
  return async (ctx) => {
    if (!(await checkSdkDoctor(ctx, prepareConfig, run))) return;
    ctx.unchecked(
      'model-access',
      'The installed Evaluator SDK doctor does not query model lists, so evaluation model availability is unchecked.',
    );
    ctx.unchecked(
      'docker-disk-capacity',
      'The installed Evaluator SDK doctor does not measure disk capacity, so evaluation storage sufficiency is unchecked.',
    );
  };
}

export const agentbenchDoctor = createAgentbenchDoctor();
