import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { compareFilePaths } from '../../shared/paths.js';
import { digest } from '../../shared/json.js';
import { safePath } from '../shared/file-application/target.js';
import { validate } from '../../shared/schema.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

export type KernelApplicationConfig = FileApplicationConfig & {
  entryFile: string;
};

export type KernelSourceFile = { path: string; sha256: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...fileConfigProperties,
    entryFile: { type: 'string', minLength: 1 },
  },
  required: ['target', 'baseline', 'entryFile'],
  additionalProperties: false,
};

export function kernelSourcePath(value: unknown): string {
  const path = safePath(value);
  if (/^[A-Za-z]:/u.test(path) || path.endsWith('/'))
    throw new Error(`Kernel sourcePath must be a relative file path: ${path}`);
  return path;
}

export function kernelBundleDigest(
  entryFile: string,
  files: KernelSourceFile[],
): string {
  return digest({
    entryFile,
    files: [...files].sort(compareFilePaths),
  });
}

/** The Application owns the source workspace until its instance is released. */
export type KernelExecution = {
  kind: 'kernel-source';
  format: 'triton-ascend';
  directory: string;
  artifactRef: string;
  sourcePath: string;
  sourceFiles: KernelSourceFile[];
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
    sourcePath: text,
    sourceFiles: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          path: text,
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        required: ['path', 'sha256'],
        additionalProperties: false,
      },
    },
    entryPoint: { const: 'kernel_function' },
    workspaceRef: text,
    artifactDigest: text,
  },
  required: [
    'kind',
    'format',
    'directory',
    'artifactRef',
    'sourcePath',
    'sourceFiles',
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
  const paths = new Set<string>();
  for (const { path } of execution.sourceFiles) {
    kernelSourcePath(path);
    if (paths.has(path))
      throw new Error(`KernelExecution duplicate source path: ${path}`);
    paths.add(path);
  }
  if (!paths.has(execution.sourcePath))
    throw new Error(
      `KernelExecution entry missing from sourceFiles: ${execution.sourcePath}`,
    );
  return execution;
}
