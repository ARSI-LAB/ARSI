import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { agentContract } from '../../../contracts/plugin-types/agent.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';

export function resolveAgent(context: DoctorContext, reference: string): void {
  const binding = context.recipe.bindings[reference];
  if (!binding)
    throw new Error(`agentRef: Agent binding ${reference} is not declared`);
  context.registry.assertContract(agentContract, binding.pluginId, reference);
}

export function missingPath(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    'code' in error &&
    error.code === 'ENOENT' &&
    'path' in error &&
    typeof error.path === 'string'
  )
    return error.path;
  return missingPath(error.cause);
}

export async function checkOperationConfiguration(
  context: DoctorContext,
): Promise<DoctorResult> {
  const configuration = await runDoctorCheck(
    'configuration',
    async (signal) => {
      const operation = await context.binding.definition.create(
        structuredClone(context.binding.config),
        context.runtime.extend({ signal }),
      );
      try {
        signal.throwIfAborted();
      } finally {
        await operation.dispose();
      }
    },
    { signal: context.signal },
  );
  return { checks: [configuration] };
}
