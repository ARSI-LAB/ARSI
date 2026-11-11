import type { DoctorContext } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { parseOptunaConfig } from './schema.js';
import {
  runOptunaWorker,
  validateOptunaWorkerResponse,
  type OptunaWorker,
} from './worker.js';

export async function checkOptunaDependencies(
  context: DoctorContext,
  worker: OptunaWorker = runOptunaWorker,
): Promise<void> {
  const config = parseOptunaConfig(context.binding.config);
  await context.check('python-dependencies', async (signal) => {
    const result = await worker(
      config,
      {
        action: 'check',
        sampler: object(config.sampler),
        constraintHandling: config.constraintHandling,
        searchSpace: config.searchSpace,
        history: [],
      },
      signal,
    );
    validateOptunaWorkerResponse(result, 'check');
  });
}
