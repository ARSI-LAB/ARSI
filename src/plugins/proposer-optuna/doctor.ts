import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
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
): Promise<DoctorResult> {
  const dependencies = await runDoctorCheck(
    'python-dependencies',
    async (signal) => {
      const config = parseOptunaConfig(context.binding.config);
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
    },
    { signal: context.signal },
  );
  return { checks: [dependencies] };
}
