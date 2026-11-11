import { join } from 'node:path';
import type { DoctorContext, OperationDoctor } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { prepareEvaluationConfig } from './service.js';

async function prepareConfig(
  ctx: DoctorContext,
  env: NodeJS.ProcessEnv,
): Promise<SdkEvaluatorConfig> {
  const directory = string(
    object(ctx.binding.config.task, 'task').directory,
    'task.directory',
  );
  const task = await loadOperatorTask(directory);
  const config = prepareEvaluationConfig(ctx.binding.config, {
    selected: task.cases[0]!,
    operation: 'evaluate',
    directory: ctx.directory,
    manifest: join(ctx.directory, 'manifest.json'),
  });
  env.RSI_KERNEL_REPLAY_NO_MODEL_KEY = 'not-a-secret-no-model-calls';
  return config;
}

export function createOperatorbenchDoctor(
  run?: SdkDoctorRunner,
): OperationDoctor {
  return async (ctx) => {
    const { checks } = await checkSdkDoctor(ctx, prepareConfig, run);
    return { checks };
  };
}

export const operatorbenchDoctor = createOperatorbenchDoctor();
