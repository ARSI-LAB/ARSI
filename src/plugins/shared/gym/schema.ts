import type { JsonObject } from '../../../contracts/index.js';

export type GymActivation =
  | { kind: 'directory'; directory: string }
  | {
      kind: 'dsh-user-layer';
      dshHome: string;
      profileName?: string;
      basePatch?: string;
    }
  | { kind: 'remote-http'; activateUrl: string; tokenEnv?: string };

const text = { type: 'string', minLength: 1 };

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
