import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { digest, object } from '../../shared/json.js';
import {
  parseTarget,
  safePath,
  type Target,
} from '../shared/file-application/target.js';
import { validate } from '../../shared/schema.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

export type KernelApplicationConfig = FileApplicationConfig & {
  entryFile?: string;
  additionalFiles?: string[];
};

export type KernelSourceLayout = JsonObject & {
  entryFile: string;
  additionalFiles: string[];
};
export type KernelSourceFile = { path: string; sha256: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...fileConfigProperties,
    entryFile: { type: 'string', minLength: 1 },
    additionalFiles: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['target', 'baseline'],
  additionalProperties: false,
};

function checkedSourcePath(value: unknown): string {
  const path = safePath(value);
  if (/^[A-Za-z]:/u.test(path) || path.endsWith('/'))
    throw new Error(`Kernel sourcePath must be a relative file path: ${path}`);
  return path;
}

export function kernelSourcePath(target: Target): string {
  const files = target.entries.filter((entry) => entry.kind === 'file');
  const [file] = files;
  if (!file || files.length !== 1)
    throw new Error('Kernel Target must contain exactly one file entry');
  return checkedSourcePath(file.path);
}

export function kernelSourceLayout(
  config: Pick<KernelApplicationConfig, 'entryFile' | 'additionalFiles'>,
  target: Target,
): KernelSourceLayout {
  if (config.additionalFiles !== undefined && config.entryFile === undefined)
    throw new Error('Kernel additionalFiles requires entryFile');
  const entryFile = checkedSourcePath(
    config.entryFile ?? kernelSourcePath(target),
  );
  const additionalFiles = (config.additionalFiles ?? [])
    .map(checkedSourcePath)
    .sort();
  const paths = [entryFile, ...additionalFiles];
  if (new Set(paths).size !== paths.length)
    throw new Error('Kernel source inventory contains duplicate paths');
  return { entryFile, additionalFiles };
}

export function kernelLayoutFromMetadata(
  metadata: JsonObject,
): KernelSourceLayout {
  const layout = object(metadata.capabilityMetadata ?? {})['kernel-source'];
  if (layout === undefined)
    return kernelSourceLayout({}, parseTarget(metadata.target));
  const config = object(layout, 'kernel-source metadata');
  validate(
    {
      type: 'object',
      additionalProperties: false,
      required: ['entryFile', 'additionalFiles'],
      properties: {
        entryFile: { type: 'string', minLength: 1 },
        additionalFiles: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    config,
    'kernel-source metadata',
  );
  return kernelSourceLayout(
    config as KernelSourceLayout,
    parseTarget(metadata.target),
  );
}

export function kernelBundleDigest(
  entryFile: string,
  files: KernelSourceFile[],
): string {
  return digest({
    entryFile,
    files: [...files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  });
}

/** The Application owns the source workspace until its instance is released. */
export type KernelExecution = JsonObject & {
  kind: 'kernel-source';
  format: 'triton-ascend';
  directory: string;
  artifactRef: string;
  sourcePath: string;
  /** SHA-256 of the unmodified source file bytes. */
  sourceDigest: string;
  sourceFiles: KernelSourceFile[];
  sourceBundleDigest: string;
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
    sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sourceBundleDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
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
    'sourceDigest',
    'entryPoint',
  ],
  additionalProperties: false,
};

export function parseKernelExecution(value: unknown): KernelExecution {
  const raw = object(value, 'KernelExecution');
  // Ready leases and acquire receipts written before sourcePath used input.py.
  const descriptor =
    raw.sourcePath === undefined &&
    typeof raw.workspaceRef === 'string' &&
    typeof raw.artifactDigest === 'string' &&
    raw.artifactDigest === raw.artifactRef
      ? { ...raw, sourcePath: 'input.py' }
      : raw;
  validate(kernelExecutionSchema, descriptor, 'KernelExecution');
  const execution = descriptor as KernelExecution;
  checkedSourcePath(execution.sourcePath);
  if (
    execution.artifactDigest !== undefined &&
    execution.artifactDigest !== execution.artifactRef
  )
    throw new Error('KernelExecution artifact identity mismatch');
  if (
    execution.sourceFiles === undefined &&
    execution.sourceBundleDigest === undefined
  ) {
    const sourceFiles = [
      { path: execution.sourcePath, sha256: execution.sourceDigest },
    ];
    return {
      ...execution,
      sourceFiles,
      sourceBundleDigest: kernelBundleDigest(execution.sourcePath, sourceFiles),
    };
  }
  if (!execution.sourceFiles || !execution.sourceBundleDigest)
    throw new Error(
      'KernelExecution requires both sourceFiles and sourceBundleDigest',
    );
  for (const file of execution.sourceFiles) checkedSourcePath(file.path);
  if (
    new Set(execution.sourceFiles.map((file) => file.path)).size !==
      execution.sourceFiles.length ||
    execution.sourceFiles.find((file) => file.path === execution.sourcePath)
      ?.sha256 !== execution.sourceDigest ||
    kernelBundleDigest(execution.sourcePath, execution.sourceFiles) !==
      execution.sourceBundleDigest
  )
    throw new Error('KernelExecution source inventory identity mismatch');
  return execution;
}
