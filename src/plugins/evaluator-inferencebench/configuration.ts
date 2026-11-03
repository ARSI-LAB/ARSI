import { join } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { clone, plain } from '../shared/evaluator-adapter/data.js';
import { solverSelection } from '../shared/evaluator-adapter/configuration.js';
import type { InferencebenchConfig } from './schema.js';
export function nativeConfiguration(
  config: InferencebenchConfig,
  _input: JsonObject,
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
  const expected = 'agentx-replay';
  if (solver.name !== undefined && solver.name !== expected)
    throw new Error(`benchmark.solver must be ${expected}`);
  solver.name = expected;
  benchmark.solver = solver;
  if (native.output !== undefined && Object.keys(object(native.output)).length)
    throw new Error('output.directory is owned by RSI');
  native.output = { directory: join(directory, 'sdk') };
  const run = plain(native.run);
  native.run = run;
  if (benchmark.name !== 'agentx')
    throw new Error('inferencebench requires benchmark.name=agentx');
  if (native.deployment !== undefined)
    throw new Error('AgentX does not support Ray Jobs');
  const environment = native.environment ?? 'local';
  if (
    environment !== 'local' &&
    !(
      typeof environment === 'object' &&
      environment !== null &&
      !Array.isArray(environment) &&
      environment.name === 'local'
    )
  )
    throw new Error('Owned inference service requires local AgentX execution');
  native.environment = environment;
  const scheduler =
    typeof native.scheduler === 'string'
      ? { name: native.scheduler }
      : plain(native.scheduler);
  if (scheduler.name !== undefined && scheduler.name !== 'local')
    throw new Error('AgentX scheduler must be local');
  const schedulerConfig = plain(scheduler.config);
  const concurrency = scheduler.concurrency ?? schedulerConfig.concurrency ?? 1;
  if (concurrency !== 1)
    throw new Error('AgentX scheduler concurrency must be 1');
  native.scheduler = { ...scheduler, name: 'local', concurrency: 1 };
  const services = object(native.services, 'services');
  const service =
    typeof solver.service === 'string' ? solver.service : 'default';
  const model = object(services[service], `services.${service}`);
  if (model.maxTokens !== undefined)
    throw new Error('AgentX services.maxTokens is forbidden');
  model.base_url = string(execution.baseUrl, 'inference baseUrl');
  model.model = string(execution.model, 'inference model');
  model.api = 'openai-completions';
  if (typeof execution.credentialRef === 'string')
    model.api_key = execution.credentialRef.startsWith('${')
      ? execution.credentialRef
      : `\${${execution.credentialRef}}`;
  services[service] = model;
  for (const service of Object.values(object(native.services))) {
    const m = object(service);
    if (
      m.api_key !== undefined &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(string(m.api_key))
    )
      throw new Error('services api_key must be an environment reference');
  }
  return native;
}
