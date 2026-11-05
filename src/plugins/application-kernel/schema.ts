import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { validate } from '../../shared/schema.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

export type KernelApplicationConfig = FileApplicationConfig;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: fileConfigProperties,
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
