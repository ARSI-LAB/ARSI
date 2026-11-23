import type { JsonObject, JsonValue } from '../../contracts/json.js';
import {
  learningNames,
  learningTriggerSchema,
  type LearningKind,
  type LearningTrigger,
} from '../../contracts/learning.js';
import { validate } from '../../shared/schema.js';

export type LearningObserve = {
  bindings?: string[];
  excludeBindings?: string[];
  steps?: string[];
  excludeSteps?: string[];
  includeBaseline?: boolean;
  includeCandidateSources?: boolean;
  includeCandidateDiffs?: boolean;
  includeAgentTraces?: boolean;
  includeDocumentPreviews?: boolean;
  includeRevisionComparisons?: boolean;
};
type LearningConfig = {
  digest: string;
  goal: string;
  goalFile: string;
  plugin: string;
  config: JsonObject;
  agentBinding?: { plugin: string; config: JsonObject };
  observe: LearningObserve;
  trigger: LearningTrigger;
  evidenceView: 'execution' | 'training-summary';
  budget: {
    modelCalls?: number;
    elapsedWallMs?: number;
    evidenceBytes?: number;
  };
};
export type MemoryConfig = LearningConfig & {
  consumers: string[];
  seed?: { directory: string };
  seedArtifactRef?: string;
};
export type ReflectionConfig = LearningConfig & {
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
  kind: LearningKind,
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
        trigger: { ...learningTriggerSchema, required: ['on', 'every'] },
        observe: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bindings: learningNames,
            excludeBindings: learningNames,
            steps: learningNames,
            excludeSteps: learningNames,
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
              consumers: learningNames,
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
                  properties: { resources: learningNames },
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
