import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';

const text: JsonObject = { type: 'string', minLength: 1 };
export const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^[a-f0-9]{64}$',
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
export type OperatorbenchConfig = SdkOperatorbenchConfig;
export const configSchema = recordSchema({
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
  sourceDigest: hashSchema,
  artifactRef: text,
  runId: { type: ['string', 'null'] },
  attemptId: { type: ['string', 'null'] },
  realNpuRuns: { type: 'null' },
  cleanup: { enum: ['confirmed', 'unknown'] },
});
export const sdkDetailsSchema = recordSchema({
  mode: { const: 'sdk' },
  operation: { enum: ['evaluate', 'profile'] },
  sourceDigest: hashSchema,
  caseId: text,
  assessment: { type: ['object', 'null'] },
  profile: { type: ['object', 'null'] },
});
