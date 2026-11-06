import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import {
  clone,
  nullableObject,
  plain,
} from '../shared/evaluator-adapter/data.js';
export function conditions(
  config: SdkEvaluatorConfig,
  snapshot: JsonObject | null,
  execution: JsonObject,
): JsonObject {
  const run = snapshot ? plain(snapshot.run) : {};
  const source = run.source ?? null;
  const identity = run.identity ?? null;
  const solver = nullableObject(run.solverProvenance);
  const fixed = object(clone(config));
  const unresolved: string[] = [];
  for (const value of Object.values(plain(fixed.services))) {
    const service = object(value);
    delete service.api_key;
    for (const field of ['model', 'base_url'])
      if (typeof service[field] === 'string')
        service[field] = string(service[field]).replace(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_match, name: string) => {
            const resolved = process.env[name];
            if (resolved === undefined) {
              unresolved.push(name);
              return `{unknown:${name}}`;
            }
            return resolved;
          },
        );
  }
  delete fixed.output;
  const r = plain(fixed.run);
  delete r.taskIds;
  delete r.maxTasks;
  delete r.sampling;
  fixed.run = r;
  const b = object(fixed.benchmark);
  const s = plain(b.solver);
  const sc = plain(s.config);
  delete sc.path;
  delete sc.dshhome;
  delete sc.dshprofile;
  s.config = sc;
  b.solver = s;
  for (const model of Object.values(plain(fixed.services))) {
    object(model).base_url = '{owned-endpoint}';
  }
  const reasons: string[] = unresolved.map(
    (name) => `Service identity environment ${name} unavailable`,
  );
  if (!source) reasons.push('SDK source identity unavailable');
  if (!identity)
    reasons.push('SDK implementation/runtime identity unavailable');
  if (!solver) reasons.push('SDK solver provenance unavailable');
  const resources = nullableObject(execution.resources);
  if (!resources || resources.verified !== true)
    reasons.push(
      'Inference device/model identity has not been independently verified',
    );
  const solverFixed = solver ? object(clone(solver)) : null;
  if (solverFixed) {
    delete solverFixed.bundle;
    delete solverFixed.installation;
  }
  return {
    protocol: 1,
    kind: 'inferencebench',
    known: reasons.length === 0,
    reasons,
    fixed: {
      config: fixed,
      source,
      identity,
      solver: solverFixed,
      taskIds: run.taskIds ?? [],
      serviceResources: execution.resources ?? null,
      environments: Array.isArray(snapshot?.records)
        ? snapshot.records.map((v) =>
            environmentConditions(plain(object(v).environments)),
          )
        : [],
    },
    candidateFactors: [
      'candidateRef',
      'service configuration',
      'service endpoint',
    ],
  };
}
function environmentConditions(raw: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [phase, value] of Object.entries(raw)) {
    if (value === null) {
      result[phase] = null;
      continue;
    }
    const env = object(value);
    const resources = clone(env.resources ?? null);
    const runtimes = Array.isArray(env.runtimes)
      ? env.runtimes.map((v) => {
          const r = object(v);
          return { name: r.name ?? null, version: r.version ?? null };
        })
      : [];
    result[phase] = {
      kind: env.kind ?? null,
      platform: env.platform ?? null,
      arch: env.arch ?? null,
      baseImage: env.baseImage ?? null,
      runtimes,
      resources,
    };
  }
  return result;
}
