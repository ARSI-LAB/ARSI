import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';

const text: JsonObject = { type: 'string', minLength: 1 };
export const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^[a-f0-9]{64}$',
};
export const diagnosticSchema = recordSchema({ code: text, message: text });
const diagnostics = { type: 'array', maxItems: 32, items: diagnosticSchema };
const caseResultSchema = recordSchema({
  caseId: text,
  outcome: {
    enum: ['valid', 'compile-failed', 'precision-failed', 'execution-failed'],
  },
  checks: {
    type: 'array',
    maxItems: 100,
    items: recordSchema({ id: text, passed: { type: 'boolean' } }),
  },
  samplesMs: {
    anyOf: [
      { type: 'null' },
      {
        type: 'array',
        minItems: 1,
        maxItems: 4096,
        items: { type: 'number', exclusiveMinimum: 0 },
      },
    ],
  },
  profile: { type: ['object', 'null'] },
  diagnostics,
});
export const mockProtocolSchema = recordSchema({
  warmup: { type: 'integer', minimum: 0, maximum: 10000 },
  repeat: { type: 'integer', minimum: 1, maximum: 4096 },
  timingScope: { const: 'all-device-work' },
  outputAllocation: { const: 'excluded' },
});
export type OperatorProtocol = {
  warmup: number;
  repeat: number;
  timingScope: string;
  outputAllocation: string;
};
export type SdkOperatorbenchConfig = {
  mode: 'sdk';
  task: { directory: string };
  protocol: {
    warmup: number;
    repeat: number;
    rtol: number;
    atol: number;
    timingScope: 'all-device-kernels';
  };
  sdk: {
    python: string;
    device: number;
    timeoutSeconds: number;
    profiling: {
      enabled: boolean;
      warmup?: number;
      collection?: 'Default' | 'PipeTimeline,Default';
      maxAttempts?: number;
      attemptTimeoutSeconds?: number;
      cacheEnabled?: boolean;
      cacheDir?: string;
      roundNum?: number;
      msprofBin?: string;
      deviceName?: string;
    };
  };
};
export type OperatorbenchConfig =
  | MockOperatorbenchConfig
  | SdkOperatorbenchConfig;
export const sdkConfigSchema = recordSchema({
  mode: { const: 'sdk' },
  task: recordSchema({ directory: { ...text, 'x-rsi-path': 'directory' } }),
  protocol: recordSchema({
    warmup: { type: 'integer', minimum: 1, maximum: 10000 },
    repeat: { type: 'integer', minimum: 1, maximum: 4096 },
    rtol: { type: 'number', minimum: 0 },
    atol: { type: 'number', minimum: 0 },
    timingScope: { const: 'all-device-kernels' },
  }),
  sdk: recordSchema({
    python: text,
    device: { type: 'integer', minimum: 0 },
    timeoutSeconds: { type: 'integer', minimum: 1 },
    profiling: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        warmup: { type: 'integer', minimum: 1 },
        collection: { enum: ['Default', 'PipeTimeline,Default'] },
        maxAttempts: { type: 'integer', minimum: 1 },
        attemptTimeoutSeconds: { type: 'integer', minimum: 1 },
        cacheEnabled: { type: 'boolean' },
        cacheDir: text,
        roundNum: { type: 'integer', minimum: 1 },
        msprofBin: text,
        deviceName: text,
      },
      required: ['enabled'],
      additionalProperties: false,
    },
  }),
});
export const sdkConditionsSchema = recordSchema({
  mode: { const: 'sdk' },
  taskDigest: hashSchema,
  adapterDigest: hashSchema,
  sdkBuildDigest: hashSchema,
  evaluation: { type: ['object', 'null'] },
});
export const sdkProvenanceSchema = recordSchema({
  mode: { const: 'sdk' },
  // Null when no instance was ever acquired (failed measurement).
  sourceDigest: { anyOf: [hashSchema, { type: 'null' }] },
  artifactRef: { anyOf: [text, { type: 'null' }] },
  runId: { type: ['string', 'null'] },
  attemptId: { type: ['string', 'null'] },
  realNpuRuns: { type: 'null' },
  cleanup: { enum: ['confirmed', 'unknown'] },
});
export const sdkDetailsSchema = recordSchema(
  {
    mode: { const: 'sdk' },
    operation: { enum: ['evaluate', 'profile'] },
    sourceDigest: { anyOf: [hashSchema, { type: 'null' }] },
    caseId: text,
    caseIds: { type: 'array', items: text },
    tiling: { type: ['object', 'null'] },
    assessment: { type: ['object', 'null'] },
    profile: { type: ['object', 'null'] },
  },
  ['mode', 'sourceDigest', 'assessment', 'profile'],
);

// Mock mode: deterministic fixture-backed assessments so the full kernel-opt
// chain runs on machines without an Ascend NPU or model credentials.
export type MockOperatorbenchConfig = {
  mode: 'mock';
  task: { directory: string };
  protocol: {
    warmup: number;
    repeat: number;
    timingScope: 'all-device-work';
    outputAllocation: 'excluded';
  };
  fixtures: string;
};
export const mockConfigSchema = recordSchema({
  mode: { const: 'mock' },
  task: recordSchema({ directory: { ...text, 'x-rsi-path': 'directory' } }),
  protocol: mockProtocolSchema,
  fixtures: { ...text, 'x-rsi-path': 'file' },
});
export const configSchema: JsonObject = {
  oneOf: [mockConfigSchema, sdkConfigSchema],
};

export const assessmentSchema = recordSchema({
  status: { enum: ['completed', 'failed', 'cancelled', 'unknown'] },
  records: { type: 'array', maxItems: 100, items: caseResultSchema },
  diagnostics,
  cleanup: { enum: ['confirmed', 'unknown'] },
});
export const fixturesSchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-fixtures/v1' },
  taskDigest: hashSchema,
  protocolDigest: hashSchema,
  assessments: {
    type: 'array',
    minItems: 1,
    items: recordSchema({
      sourceDigest: hashSchema,
      caseIds: { type: 'array', minItems: 1, uniqueItems: true, items: text },
      result: assessmentSchema,
    }),
  },
});
export const resultSchema = recordSchema({
  ...(assessmentSchema.properties as JsonObject),
  mode: { const: 'mock' },
  runId: text,
  sourceDigest: hashSchema,
  taskDigest: hashSchema,
  protocolDigest: hashSchema,
});
export const mockConditionsSchema = recordSchema({
  runnerDigest: hashSchema,
  mode: { const: 'mock' },
  taskDigest: hashSchema,
  protocolDigest: hashSchema,
  fixtureDigest: hashSchema,
  caseIds: { type: 'array', items: text },
  cases: {
    type: 'array',
    items: recordSchema({ id: text, seed: { type: 'integer' } }),
  },
  protocol: mockProtocolSchema,
});
export const mockProvenanceSchema = recordSchema({
  runnerDigest: hashSchema,
  mode: { const: 'mock' },
  // Null when no instance was ever acquired (failed measurement).
  sourceDigest: { anyOf: [hashSchema, { type: 'null' }] },
  artifactRef: { anyOf: [text, { type: 'null' }] },
  runId: text,
  realNpuRuns: { const: 0 },
  cleanup: { enum: ['confirmed', 'unknown'] },
});
export const mockProfileSchema = recordSchema({
  mode: { const: 'mock' },
  cases: {
    type: 'array',
    items: recordSchema({
      caseId: text,
      profile: { type: ['object', 'null'] },
    }),
  },
});
export const mockDetailsSchema = recordSchema({
  sourceDigest: hashSchema,
  caseId: text,
  outcome: text,
});
