import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

type InferenceCommonConfig = FileApplicationConfig & {
  healthcheck?: { path?: string; intervalMs?: number; timeoutMs?: number };
  credentials?: { apiKeyEnv?: string };
  resources?: JsonObject;
  shutdown?: { gracePeriodMs?: number };
};
export type LocalInferenceConfig = InferenceCommonConfig & {
  start: {
    argv: (string | { resource: string; path?: string })[];
    cwd?: string;
  };
  endpoint: { basePath?: string; model: string };
};
export type RemoteInferenceConfig = InferenceCommonConfig & {
  remote: {
    script: string;
    executable?: string;
    parametersFile?: string;
    timeoutMs?: number;
    discoverParameters?: boolean;
    memoryUtilization?: number;
    calibration?: {
      start: number;
      min: number;
      step: number;
      maxNumSeqs: number;
      maxNumBatchedTokens: number;
    };
  };
  endpoint: { origin: string; basePath?: string; model: string };
};
export type InferenceConfig = LocalInferenceConfig | RemoteInferenceConfig;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...fileConfigProperties,
    remote: {
      type: 'object',
      properties: {
        script: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
        executable: { type: 'string', minLength: 1 },
        parametersFile: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
        discoverParameters: { type: 'boolean' },
        memoryUtilization: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        calibration: {
          type: 'object',
          properties: {
            start: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            min: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            step: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            maxNumSeqs: { type: 'integer', minimum: 1 },
            maxNumBatchedTokens: { type: 'integer', minimum: 1 },
          },
          required: [
            'start',
            'min',
            'step',
            'maxNumSeqs',
            'maxNumBatchedTokens',
          ],
          additionalProperties: false,
        },
      },
      required: ['script'],
      not: { required: ['memoryUtilization', 'calibration'] },
      additionalProperties: false,
    },
    start: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  resource: { type: 'string' },
                  path: { type: 'string' },
                },
                required: ['resource'],
                additionalProperties: false,
              },
            ],
          },
        },
        cwd: { type: 'string' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    healthcheck: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        intervalMs: { type: 'integer', minimum: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    endpoint: {
      type: 'object',
      properties: {
        origin: { type: 'string', minLength: 1 },
        basePath: { type: 'string' },
        model: { type: 'string', minLength: 1 },
      },
      required: ['model'],
      additionalProperties: false,
    },
    credentials: {
      type: 'object',
      properties: {
        apiKeyEnv: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      },
      additionalProperties: false,
    },
    resources: { type: 'object' },
    shutdown: {
      type: 'object',
      properties: { gracePeriodMs: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  },
  required: ['target', 'baseline', 'endpoint'],
  oneOf: [
    {
      required: ['start'],
      not: { required: ['remote'] },
      properties: { endpoint: { not: { required: ['origin'] } } },
    },
    {
      required: ['remote'],
      not: { required: ['start'] },
      properties: { endpoint: { required: ['origin'] } },
    },
  ],
  additionalProperties: false,
};
