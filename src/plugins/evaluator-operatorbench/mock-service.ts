import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { parseKernelExecution } from '../application-kernel/schema.js';
import { digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { readOperatorFixtures, prepareMockRun } from './mock-runner.js';
import { recordMockMeasurement } from './mock-measurement.js';
import { recordFailedMeasurement, rejectionMessage } from './failure.js';
import { readTiling } from './service.js';
import {
  mockConditionsSchema,
  mockProvenanceSchema,
  mockProfileSchema,
  resultSchema,
  type MockOperatorbenchConfig,
} from './schema.js';
import type { OperatorRunRequest, OperatorRunResult } from './runner.js';

const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function validateResult(
  result: unknown,
  request: OperatorRunRequest,
): asserts result is OperatorRunResult {
  validate(resultSchema, result, 'operator result');
  const raw = object(result);
  for (const name of ['runId', 'taskDigest', 'protocolDigest'] as const)
    if (raw[name] !== request[name])
      throw new Error(`Operator result ${name} mismatch`);
  if (raw.sourceDigest !== request.execution.sourceDigest)
    throw new Error('Operator result source digest mismatch');
  const records = raw.records as JsonObject[];
  const ids = records.map((r) => string(r.caseId));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !request.caseIds.includes(id))
  )
    throw new Error('Operator result case IDs mismatch');
  if (raw.status === 'completed' && ids.length !== request.caseIds.length)
    throw new Error(
      'Completed operator assessment must cover every requested case',
    );
  for (const record of records) {
    const checks = record.checks as JsonObject[];
    if (record.outcome === 'valid') {
      for (const id of [
        'compile',
        'shape',
        'dtype',
        'layout',
        'independent-output',
        'input-unmodified',
        'numerical',
      ])
        if (checks.filter((c) => c.id === id && c.passed === true).length !== 1)
          throw new Error(`Valid operator result lacks passed ${id} check`);
      if (checks.some((c) => c.passed !== true))
        throw new Error('Valid operator result has failed checks');
      if (
        !Array.isArray(record.samplesMs) ||
        record.samplesMs.length !== request.protocol.repeat
      )
        throw new Error(
          'Valid operator result has missing or incomplete timing samples',
        );
    } else if (record.samplesMs !== null)
      throw new Error(
        'Invalid operator candidate must not contain timing samples',
      );
  }
}

/**
 * Fixture-backed operatorbench: the full evaluate path (lifecycle acquire,
 * precheck rejection handling, measurement recording, status output) with the
 * NPU replaced by deterministic fixture assessments.
 */
export async function createMockOperatorbench(
  config: MockOperatorbenchConfig,
  _services: RuntimeContext,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const executionIdentity = digest({ runner: 'rsi.operator-mock/v1' });
  const task = await loadOperatorTask(config.task.directory);
  const fixtures = await readOperatorFixtures(config.fixtures);
  const protocolDigest = digest(config.protocol);
  if (fixtures.taskDigest !== task.taskDigest)
    throw new Error('Operator fixture task digest mismatch');
  if (fixtures.protocolDigest !== protocolDigest)
    throw new Error('Operator fixture protocol digest mismatch');
  return {
    async execute(input, context) {
      validate(
        operatorbenchContract.input_schema,
        input,
        'operatorbench input',
      );
      if (input.action !== 'evaluate')
        throw new Error('operatorbench mock mode supports evaluate only');
      context.signal.throwIfAborted();
      const selected = input.caseIds.map((id) => {
        const entry = task.cases.find((c) => c.id === id);
        if (!entry) throw new Error(`Unknown operator case ${id}`);
        return entry;
      });
      try {
        return await context.withInstance(
          input.candidateRef,
          'kernel-source',
          async (raw) => {
            // A precheck-rejected candidate arrives as an unverified
            // execution; it is never compared, only recorded.
            const rejection = rejectionMessage(raw);
            if (rejection !== null) throw new Error(rejection);
            const execution = parseKernelExecution(raw);
            const source = join(execution.directory, 'input.py');
            if (
              !(await lstat(source)).isFile() ||
              sha(await readFile(source)) !== execution.sourceDigest
            )
              throw new Error('Operator source digest mismatch');
            // The candidate's tiling parameters ride along in the digest so
            // cross-run memory can attribute latencies to block sizes.
            const tiling = await readTiling(execution.directory);
            const request: OperatorRunRequest = {
              execution,
              taskDigest: task.taskDigest,
              protocolDigest,
              fixtureDigest: digest(fixtures),
              runnerDigest: executionIdentity,
              caseIds: input.caseIds,
              cases: selected,
              protocol: config.protocol,
              runId: context.idempotencyKey,
              directory: context.directory,
              signal: context.signal,
            };
            const mockRun = prepareMockRun(fixtures, request);
            context.signal.throwIfAborted();
            await context.charge('evaluationRuns', 1);
            let result: OperatorRunResult;
            try {
              result = await mockRun();
            } catch (error) {
              result = {
                mode: 'mock',
                runId: request.runId,
                sourceDigest: execution.sourceDigest,
                taskDigest: task.taskDigest,
                protocolDigest,
                status: context.signal.aborted ? 'cancelled' : 'unknown',
                cleanup: 'unknown',
                records: [],
                diagnostics: [
                  {
                    code: 'RUNNER_ERROR',
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                ],
              };
            }
            validateResult(result, request);
            const measurementRef = await recordMockMeasurement(
              result,
              input,
              execution,
              context,
              request,
              tiling,
            );
            // A recorded non-completed assessment is an evaluation outcome the
            // policy can consume (stale round), not a runner crash.
            const status =
              result.cleanup === 'unknown'
                ? 'unknown'
                : result.status === 'completed'
                  ? 'succeeded'
                  : result.status;
            // An aborted call is never a policy-consumable outcome.
            if (context.signal.aborted)
              throw Object.assign(new Error('Operator assessment cancelled'), {
                measurementRef,
                status,
              });
            return { action: 'evaluate' as const, measurementRef, status };
          },
        );
      } catch (error) {
        // A candidate the lifecycle could not prepare (e.g. the precheck
        // rejected the kernel) is an evaluation outcome, not a runner crash:
        // record a failed measurement so the policy loop counts a stale round
        // and converges instead of dying mid-run with a non-resumable receipt.
        // The catch sits OUTSIDE withInstance because acquire/precheck
        // rejections happen before the closure runs.
        if (context.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return recordFailedMeasurement(input, context, {
          message,
          caseIds: input.caseIds,
          runnerDigest: executionIdentity,
          tiling: null,
          conditions: {
            schemaId: 'rsi.operator-conditions/v1',
            schema: mockConditionsSchema,
            value: {
              runnerDigest: executionIdentity,
              mode: 'mock',
              taskDigest: task.taskDigest,
              protocolDigest,
              fixtureDigest: digest(fixtures),
              caseIds: input.caseIds,
              cases: selected,
              protocol: config.protocol,
            },
          },
          provenance: {
            schemaId: 'rsi.operator-provenance/v1',
            schema: mockProvenanceSchema,
            value: {
              runnerDigest: executionIdentity,
              mode: 'mock',
              sourceDigest: null,
              artifactRef: null,
              runId: context.idempotencyKey,
              realNpuRuns: 0,
              cleanup: 'unknown',
            },
          },
          profile: {
            schemaId: 'rsi.operator-profile/v1',
            schema: mockProfileSchema,
            value: { mode: 'mock', cases: [] },
          },
        });
      }
    },
    async dispose() {},
  };
}
