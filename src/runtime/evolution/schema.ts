import type { JsonObject, JsonValue } from '../../contracts/json.js';
import {
  runtimeEvolutionNames,
  runtimeEvolutionTriggerSchema,
  type RuntimeEvolutionKind,
  type RuntimeEvolutionTrigger,
} from '../../contracts/runtime-evolution.js';
import { validate } from '../../shared/schema.js';

export type RuntimeEvolutionObserve = {
  bindings?: string[];
  excludeBindings?: string[];
  steps?: string[];
  excludeSteps?: string[];
  includeBaseline?: boolean;
  includeCandidateDiffs?: boolean;
};
type RuntimeEvolutionConfig = {
  digest: string;
  goal: string;
  goalFile: string;
  plugin: string;
  config: JsonObject;
  agentBinding?: { plugin: string; config: JsonObject };
  observe: RuntimeEvolutionObserve;
  trigger: RuntimeEvolutionTrigger;
  evidenceView: 'execution' | 'training-summary';
  budget: {
    modelCalls?: number;
    elapsedWallMs?: number;
    evidenceBytes?: number;
  };
};
export type MemoryConfig = RuntimeEvolutionConfig & {
  consumers: string[];
  seed?: { directory: string };
  seedArtifactRef?: string;
};
export type ReflectionConfig = RuntimeEvolutionConfig & {
  targets: Record<string, { resources: string[] }>;
};
const text = { type: 'string', minLength: 1 };
const number = { type: 'integer', minimum: 0 };
export function parseLockedConfig(kind: 'memory', raw: JsonValue): MemoryConfig;
export function parseLockedConfig(
  kind: 'reflection',
  raw: JsonValue,
): ReflectionConfig;
export function parseLockedConfig(
  kind: RuntimeEvolutionKind,
  raw: JsonValue,
): MemoryConfig | ReflectionConfig {
  validate(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'digest',
        'plugin',
        'goal',
        'goalFile',
        'config',
        'trigger',
        'observe',
        'evidenceView',
        'budget',
        kind === 'memory' ? 'consumers' : 'targets',
      ],
      properties: {
        digest: text,
        plugin: text,
        goal: text,
        goalFile: text,
        config: { type: 'object' },
        agentBinding: {
          type: 'object',
          properties: {
            plugin: { const: 'agent.pi' },
            config: { type: 'object' },
          },
          required: ['plugin', 'config'],
          additionalProperties: false,
        },
        trigger: {
          ...runtimeEvolutionTriggerSchema,
          required: ['on', 'every'],
        },
        observe: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bindings: runtimeEvolutionNames,
            excludeBindings: runtimeEvolutionNames,
            steps: runtimeEvolutionNames,
            excludeSteps: runtimeEvolutionNames,
            includeCandidateDiffs: { type: 'boolean' },
            includeBaseline: { type: 'boolean' },
          },
        },
        evidenceView: { enum: ['execution', 'training-summary'] },
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            modelCalls: number,
            elapsedWallMs: number,
            evidenceBytes: number,
          },
        },
        ...(kind === 'memory'
          ? {
              consumers: runtimeEvolutionNames,
              seed: {
                type: 'object',
                properties: { directory: text },
                required: ['directory'],
                additionalProperties: false,
              },
              seedArtifactRef: text,
            }
          : {
              targets: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: { resources: runtimeEvolutionNames },
                  required: ['resources'],
                  additionalProperties: false,
                },
              },
            }),
      },
    },
    raw,
    'locked ' + kind,
  );
  return raw as MemoryConfig | ReflectionConfig;
}
