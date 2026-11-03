import { join } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object, string, strings } from '../../shared/json.js';
import { clone, plain } from '../shared/evaluator-adapter/data.js';
import { solverSelection } from '../shared/evaluator-adapter/configuration.js';
import type { AgentbenchConfig } from './schema.js';
export function nativeConfiguration(
  config: AgentbenchConfig,
  input: JsonObject,
  execution: JsonObject,
  directory: string,
): JsonObject {
  const native = object(clone(config));
  const benchmark =
    typeof native.benchmark === 'string'
      ? { name: native.benchmark }
      : object(native.benchmark, 'benchmark');
  native.benchmark = benchmark;
  const solver = solverSelection(benchmark.solver);
  const solverConfig = plain(solver.config);
  solver.config = solverConfig;
  const expected = 'agentbundle';
  if (solver.name !== undefined && solver.name !== expected)
    throw new Error(`benchmark.solver must be ${expected}`);
  solver.name = expected;
  benchmark.solver = solver;
  if (native.output !== undefined && Object.keys(object(native.output)).length)
    throw new Error('output.directory is owned by RSI');
  native.output = { directory: join(directory, 'sdk') };
  const run = plain(native.run);
  native.run = run;
  if (solverConfig.path !== undefined)
    throw new Error('benchmark.solver.config.path is owned by RSI');
  solverConfig.path = string(execution.directory, 'Bundle directory');
  delete run.sampling;
  run.maxTasks = null;
  run.taskIds = strings(input.taskIds, 'taskIds');
  const scheduler =
    typeof native.scheduler === 'string'
      ? { name: native.scheduler }
      : plain(native.scheduler);
  if (scheduler.name === undefined || scheduler.name === 'local') {
    const preparation = plain(run.preparation);
    if (preparation.mode === undefined || preparation.mode === 'pipeline') {
      run.preparation = {
        mode: 'pipeline',
        concurrency:
          scheduler.concurrency ?? plain(scheduler.config).concurrency ?? 1,
        ...preparation,
      };
    }
  }
  for (const service of Object.values(object(native.services))) {
    const m = object(service);
    if (m.maxTokens === undefined) m.maxTokens = 65536;
    if (
      m.api_key !== undefined &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(string(m.api_key))
    )
      throw new Error('services api_key must be an environment reference');
  }
  return native;
}
