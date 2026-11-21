import type {
  DoctorContext,
  DoctorResult,
  GymInput,
  GymOutput,
  OperationDefinition,
  OperationEvents,
} from '../../contracts/index.js';
import { gymContract } from '../../contracts/plugin-types/index.js';
import { gymDoctor } from './evaluate/doctor.js';
import { gymPromotionDoctor } from './promotion/doctor.js';
import { gymPluginConfigSchema, type GymPluginConfig } from './schema.js';
import { createGymOperation } from './service.js';

async function doctor(
  context: DoctorContext<GymPluginConfig>,
): Promise<DoctorResult> {
  const config = context.binding.config;
  return config.mode === 'evaluate'
    ? gymDoctor({
        ...context,
        binding: { ...context.binding, config },
      })
    : gymPromotionDoctor({
        ...context,
        binding: { ...context.binding, config },
      });
}

export const gymDefinition: OperationDefinition<
  GymInput,
  GymOutput,
  GymPluginConfig
> = {
  id: 'evaluator.gym',
  description:
    'Run mode-restricted Gym training evaluations or holdout promotions.',
  contract: gymContract,
  configSchema: gymPluginConfigSchema,
  create: (config, context) => createGymOperation(config, context),
};

export function gymEvents(events: OperationEvents<GymPluginConfig>): void {
  events.on('rsi/doctor', doctor);
}
