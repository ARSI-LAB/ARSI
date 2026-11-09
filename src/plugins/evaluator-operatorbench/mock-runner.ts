import { readFile } from 'node:fs/promises';
import { digest, strings } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { fixturesSchema } from './schema.js';
import type {
  OperatorAssessment,
  OperatorRunRequest,
  OperatorRunResult,
} from './runner.js';

export type OperatorFixtures = {
  schemaVersion: string;
  taskDigest: string;
  protocolDigest: string;
  assessments: {
    sourceDigest: string;
    caseIds: string[];
    result: OperatorAssessment;
  }[];
};
export async function readOperatorFixtures(
  path: string,
): Promise<OperatorFixtures> {
  return parseConfig<OperatorFixtures>(
    fixturesSchema,
    JSON.parse(await readFile(path, 'utf8')),
    'operator fixtures',
  );
}
/** Resolve a known fixture before execution budgets are charged. */
export function prepareMockRun(
  fixtures: OperatorFixtures,
  request: OperatorRunRequest,
): () => Promise<OperatorRunResult> {
  if (fixtures.taskDigest !== request.taskDigest)
    throw new Error('Operator fixture task digest mismatch');
  if (fixtures.protocolDigest !== request.protocolDigest)
    throw new Error('Operator fixture protocol digest mismatch');
  if (digest(fixtures) !== request.fixtureDigest)
    throw new Error('Operator fixture set digest mismatch');
  const matches = fixtures.assessments.filter(
    (entry) =>
      entry.sourceDigest === request.execution.sourceDigest &&
      digest(strings(entry.caseIds)) === digest(request.caseIds),
  );
  if (matches.length !== 1)
    throw new Error(
      `Operator source/case fixture must match exactly once; matched ${matches.length}`,
    );
  const assessment = matches[0]!.result;
  return async () => {
    request.signal.throwIfAborted();
    const result: OperatorRunResult = {
      ...structuredClone(assessment),
      mode: 'mock',
      runId: request.runId,
      sourceDigest: request.execution.sourceDigest,
      taskDigest: request.taskDigest,
      protocolDigest: request.protocolDigest,
    };
    return result;
  };
}
