import type { JsonObject } from '../../contracts/index.js';
import type { KernelExecution } from '../application-kernel/schema.js';
import type { OperatorProtocol } from './schema.js';
export type OperatorDiagnostic = { code: string; message: string };
export type OperatorCaseResult = {
  caseId: string;
  outcome: 'valid' | 'compile-failed' | 'precision-failed' | 'execution-failed';
  checks: { id: string; passed: boolean }[];
  samplesMs: number[] | null;
  profile: JsonObject | null;
  diagnostics: OperatorDiagnostic[];
};
export type OperatorAssessment = {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  cleanup: 'confirmed' | 'unknown';
  records: OperatorCaseResult[];
  diagnostics: OperatorDiagnostic[];
};
type OperatorResultIdentity = {
  mode: 'mock';
  runId: string;
  sourceDigest: string;
  taskDigest: string;
  protocolDigest: string;
};
export type OperatorRunResult = OperatorResultIdentity &
  (
    | (OperatorAssessment & { status: 'completed' })
    | (OperatorAssessment & { status: 'failed' | 'cancelled' | 'unknown' })
  );
export interface OperatorRunRequest {
  execution: KernelExecution;
  taskDigest: string;
  protocolDigest: string;
  fixtureDigest: string;
  runnerDigest: string;
  caseIds: string[];
  cases: { id: string; seed: number }[];
  protocol: OperatorProtocol;
  runId: string;
  directory: string;
  signal: AbortSignal;
}
/** The runner owns execution only; it cannot change sources or Manager facts. */
export type OperatorRunner = (
  request: OperatorRunRequest,
) => Promise<OperatorRunResult>;
