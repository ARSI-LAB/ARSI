import { join } from 'node:path';
import type {
  DoctorContext,
  DoctorRule,
  JsonValue,
  OperationDoctor,
} from '../../contracts/index.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { sdkDoctorRules } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { prepareEvaluationConfig } from './service.js';

export function createAgentbenchDoctor(run?: SdkDoctorRunner): OperationDoctor {
  return (context) => {
    const baseline = plain(context.recipe.application.config.baseline);
    const instanceScope: DoctorRule[] =
      typeof baseline.directory !== 'string' &&
      typeof baseline.artifactRef !== 'string'
        ? [
            {
              id: 'application-instance',
              reason:
                'The Application supplies its instance during execution; SDK doctor uses a temporary path without establishing instance readiness.',
            },
          ]
        : [];
    return [
      ...instanceScope,
      ...sdkDoctorRules(context, prepareAgentbenchConfig, run),
      {
        id: 'model-access',
        reason:
          'The installed Evaluator SDK doctor does not query model lists, so evaluation model availability is unchecked.',
      },
      {
        id: 'docker-disk-capacity',
        reason:
          'The installed Evaluator SDK doctor does not measure disk capacity, so evaluation storage sufficiency is unchecked.',
      },
    ];
  };
}

export const agentbenchDoctor = createAgentbenchDoctor();

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

async function prepareBundleDirectory(context: DoctorContext): Promise<string> {
  const baseline = plain(context.recipe.application.config.baseline);
  if (typeof baseline.directory === 'string') return baseline.directory;
  if (typeof baseline.artifactRef === 'string') {
    const directory = join(context.directory, 'baseline');
    await context.runtime.artifacts.materialize(
      baseline.artifactRef,
      directory,
    );
    return directory;
  }
  return context.directory;
}

async function prepareAgentbenchConfig(
  context: DoctorContext,
): Promise<SdkEvaluatorConfig> {
  if (
    ['application.inference', 'application.kernel'].includes(
      context.recipe.application.pluginId,
    )
  )
    throw new Error(
      'evaluator.agentbench requires an Application with the agentbundle capability.',
    );
  return prepareEvaluationConfig(context.binding.config, {
    taskIds: [...new Set(taskIds(context.recipe.policyConfig))],
    execution: { directory: await prepareBundleDirectory(context) },
    directory: context.directory,
  });
}
