import type { JsonObject } from '../../contracts/index.js';

export type GymSplit = 'train_probe' | 'train_full';

export type GymTier = 'probe' | 'screen' | 'full';

export type GymActivation =
  | { kind: 'directory'; directory: string }
  | {
      kind: 'dsh-user-layer';
      dshHome: string;
      profileName?: string;
      basePatch?: string;
    }
  | { kind: 'remote-http'; activateUrl: string; tokenEnv?: string };

/** Fixed request defaults; every evaluation under one binding shares them. */
export type GymRequestDefaults = {
  adapter: string;
  benchmark: string;
  split: GymSplit;
  tier: GymTier;
  seed: number;
  harnessManifest?: string;
};

export type GymConfig = {
  baseUrl: string;
  requestDefaults: GymRequestDefaults;
  poll?: { intervalMs?: number; timeoutMs?: number };
  budget?: { maxRollouts?: number; timeoutS?: number };
  /**
   * Publish the acquired candidate before Gym starts its rollout. Gym has no
   * candidate-path request field, so a fixed activation surface is required.
   * Omit only when the adapter already reads a candidate published externally.
   */
  activation?: GymActivation;
};

const text = { type: 'string', minLength: 1 };
const integer = { type: 'integer' };

export const gymActivationSchema: JsonObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'directory' },
        directory: {
          ...text,
          description:
            'Fixed directory read by the Gym adapter; replaced on each candidate activation.',
        },
      },
      required: ['kind', 'directory'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'dsh-user-layer' },
        dshHome: {
          ...text,
          description:
            'DSH_HOME visible to Gym; the evaluator replaces the profile user layer.',
        },
        profileName: { ...text, default: 'headless' },
        basePatch: {
          ...text,
          description:
            'Host-owned DSH patch list merged before the candidate patch; use it for model routes and credential references that must survive candidate activation.',
        },
      },
      required: ['kind', 'dshHome'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'remote-http' },
        activateUrl: {
          ...text,
          description: 'HTTP endpoint that installs the supplied bundle.',
        },
        tokenEnv: {
          ...text,
          description: 'Environment variable containing a bearer token.',
        },
      },
      required: ['kind', 'activateUrl'],
    },
  ],
};

function schema(split: JsonObject): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      baseUrl: {
        ...text,
        description: 'eval_service base URL, for example http://127.0.0.1:8411',
      },
      requestDefaults: {
        type: 'object',
        additionalProperties: false,
        properties: {
          adapter: text,
          benchmark: text,
          split,
          tier: { enum: ['probe', 'screen', 'full'] },
          seed: integer,
          harnessManifest: text,
        },
        required: ['adapter', 'benchmark', 'split', 'tier', 'seed'],
      },
      poll: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intervalMs: { type: 'integer', minimum: 100 },
          timeoutMs: { type: 'integer', minimum: 1000 },
        },
      },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxRollouts: { type: 'integer', minimum: 1 },
          timeoutS: { type: 'integer', minimum: 1 },
        },
      },
      activation: gymActivationSchema,
    },
    required: ['baseUrl', 'requestDefaults'],
  };
}

/** Holdout is not requestable through Gym's outer evaluation contract (OF-2). */
export const gymConfigSchema: JsonObject = schema({
  enum: ['train_probe', 'train_full'],
});
