import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { validate } from '../../shared/schema.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';
import type { ScriptedLifecycle } from '../shared/scripted-lifecycle/index.js';

export type KernelApplicationConfig = FileApplicationConfig & {
  /** Optional scripted lifecycle (start/status/stop) driving sync, build,
   * and the correctness precheck on the target; absent means plain files. */
  lifecycle?: ScriptedLifecycle;
  healthcheck?: { intervalMs?: number; timeoutMs?: number };
  shutdown?: { gracePeriodMs?: number };
};

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...fileConfigProperties,
    lifecycle: {
      type: 'object',
      properties: {
        script: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
        executable: { type: 'string', minLength: 1 },
        parametersFile: { type: 'string', minLength: 1 },
        // Covers kernel compile/load plus the correctness precheck; calibrate
        // from measured build timings per the design.
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      required: ['script'],
      additionalProperties: false,
    },
    healthcheck: {
      type: 'object',
      properties: {
        intervalMs: { type: 'integer', minimum: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    shutdown: {
      type: 'object',
      properties: { gracePeriodMs: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  },
  required: ['target', 'baseline'],
  additionalProperties: false,
};

/** The Application owns the source workspace until its instance is released. */
export type KernelExecution = JsonObject & {
  kind: 'kernel-source';
  format: 'triton-ascend';
  directory: string;
  artifactRef: string;
  /** SHA-256 of the actual UTF-8 bytes in input.py. */
  sourceDigest: string;
  entryPoint: 'kernel_function';
  workspaceRef?: string;
  artifactDigest?: string;
};

const text: JsonObject = { type: 'string', minLength: 1 };
export const kernelExecutionSchema: JsonSchema = {
  type: 'object',
  properties: {
    kind: { const: 'kernel-source' },
    format: { const: 'triton-ascend' },
    directory: text,
    artifactRef: text,
    sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    entryPoint: { const: 'kernel_function' },
    workspaceRef: text,
    artifactDigest: text,
  },
  required: [
    'kind',
    'format',
    'directory',
    'artifactRef',
    'sourceDigest',
    'entryPoint',
  ],
  additionalProperties: false,
};

/**
 * Parses a verified KernelExecution. A precheck-rejected acquire resolves a
 * RAW execution-shaped object with extra `resources:{verified:false}` and
 * `rejection` keys instead of throwing; consumers must run the evaluator's
 * rejectionMessage(raw) BEFORE parseKernelExecution(raw) — the schema never
 * sees a rejected execution, so additionalProperties stays closed.
 */
export function parseKernelExecution(value: unknown): KernelExecution {
  validate(kernelExecutionSchema, value, 'KernelExecution');
  const execution = value as KernelExecution;
  if (
    execution.artifactDigest !== undefined &&
    execution.artifactDigest !== execution.artifactRef
  )
    throw new Error('KernelExecution artifact identity mismatch');
  return execution;
}
