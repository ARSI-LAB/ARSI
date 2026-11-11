import type { DoctorContext } from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath, resolveAgent } from '../shared/doctor/checks.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import type { OperatorProposerConfig } from './schema.js';
import { loadOperatorResources, readHardwareContext } from './service.js';

export async function checkOperatorProposer(
  context: DoctorContext,
): Promise<void> {
  const config = parseConfig<OperatorProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  await context.check('agent-binding', async () => {
    resolveAgent(context, config.agentRef);
  });
  await context.check('operator-task', async (signal) => {
    signal.throwIfAborted();
    try {
      await loadOperatorTask(config.task.directory);
    } catch (error) {
      const path = missingPath(error);
      if (path)
        context.missing({
          field: 'config.task.directory',
          kind: 'file',
          reference: path,
          checksNotRun: [],
        });
      throw error;
    }
  });
  await context.check('operator-resources', async (signal) => {
    signal.throwIfAborted();
    try {
      await loadOperatorResources(config);
    } catch (error) {
      const path = missingPath(error);
      if (path)
        context.missing({
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
  });
  if (config.hardwareContextFile)
    await context.check('hardware-context', async () => {
      await readHardwareContext(config.hardwareContextFile!);
    });
}
