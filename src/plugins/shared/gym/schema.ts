import type { JsonObject } from '../../../contracts/index.js';

/**
 * A Gym publisher is the only harness-owned surface in the RSI/Gym contract.
 * evaluator.gym and release.gym depend on this port, never on a harness name:
 * switching AgentBundle kinds selects another publisher instead of adding a
 * harness branch to the Gym core.
 */
export type GymPublisher =
  | {
      kind: 'directory';
      /** Fixed directory read by the Gym adapter. */
      directory: string;
      /** Optional activation sidecar written inside the published directory. */
      manifestPath?: string;
      /** Reject manifests whose kind is not listed. Omit to accept any kind. */
      bundleKinds?: string[];
    }
  | {
      kind: 'dsh-user-layer';
      dshHome: string;
      profileName?: string;
      basePatch?: string;
      bundleKinds?: string[];
    }
  | {
      kind: 'remote-http';
      activateUrl: string;
      tokenEnv?: string;
      bundleKinds?: string[];
    };

/** @deprecated Use GymPublisher. */
export type GymActivation = GymPublisher;

/** A materialized AgentBundle handed to a publisher before Gym starts. */
export interface GymBundlePublication {
  candidateRef: string;
  directory: string;
  bundleDigest: string;
  /** Manifest kind reported by agent-bundle-core, when available. */
  bundleKind?: string;
}

const text = { type: 'string', minLength: 1 };
const bundleKinds = {
  type: 'array',
  items: text,
  minItems: 1,
  uniqueItems: true,
  description:
    'AgentBundle manifest kinds this publisher accepts; omit to accept any kind.',
};

export const gymPublisherSchema: JsonObject = {
  description:
    'Harness-owned surface that receives the candidate before a Gym rollout.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'directory' },
        directory: {
          ...text,
          description:
            'Fixed directory read by the Gym adapter; replaced on each candidate publication.',
        },
        manifestPath: {
          ...text,
          description:
            'Optional sidecar path inside the published directory, for example .rsi-gym-activation.json.',
        },
        bundleKinds,
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
            'DSH_HOME visible to Gym; the publisher replaces the profile user layer.',
        },
        profileName: { ...text, default: 'headless' },
        basePatch: {
          ...text,
          description:
            'Host-owned DSH patch list merged before the candidate patch; use it for model routes and credential references that must survive candidate publication.',
        },
        bundleKinds,
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
        bundleKinds,
      },
      required: ['kind', 'activateUrl'],
    },
  ],
};

/** @deprecated Use gymPublisherSchema. */
export const gymActivationSchema: JsonObject = gymPublisherSchema;
