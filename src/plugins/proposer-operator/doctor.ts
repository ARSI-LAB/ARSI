import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath, resolveAgent } from '../shared/doctor/checks.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import type { OperatorProposerConfig } from './schema.js';
import { loadOperatorResources, readHardwareContext } from './service.js';

export async function checkOperatorProposer(
  context: DoctorContext,
): Promise<DoctorResult> {
  const config = parseConfig<OperatorProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const options = { signal: context.signal };
  const missingResources: NonNullable<DoctorResult['missingResources']> = [];
  const agentBinding = await runDoctorCheck(
    'agent-binding',
    async () => resolveAgent(context, config.agentRef),
    options,
  );
  const operatorTask = await runDoctorCheck(
    'operator-task',
    async (signal) => {
      signal.throwIfAborted();
      try {
        await loadOperatorTask(config.task.directory);
      } catch (error) {
        const path = missingPath(error);
        if (path)
          missingResources.push({
            field: 'config.task.directory',
            kind: 'file',
            reference: path,
            checksNotRun: [],
          });
        throw error;
      }
    },
    options,
  );
  const resources = await runDoctorCheck(
    'operator-resources',
    async (signal) => {
      signal.throwIfAborted();
      try {
        await loadOperatorResources(config);
      } catch (error) {
        const path = missingPath(error);
        if (path)
          missingResources.push({
            field: path.startsWith(config.promptsDirectory)
              ? 'config.promptsDirectory'
              : path === config.embedding.retrievalScript
                ? 'config.embedding.retrievalScript'
                : 'config.embedding.resourcesDirectory',
            kind: 'file',
            reference: path,
            checksNotRun: [],
          });
        throw error;
      }
    },
    options,
  );
  const checks = [agentBinding, operatorTask, resources];
  const hardwareContextFile = config.hardwareContextFile;
  if (hardwareContextFile)
    checks.push(
      await runDoctorCheck(
        'hardware-context',
        async () => {
          await readHardwareContext(hardwareContextFile);
        },
        options,
      ),
    );
  return { checks, missingResources };
}
