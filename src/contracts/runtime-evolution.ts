import type { JsonObject } from './json.js';

export type RuntimeEvolutionKind = 'memory' | 'reflection';
export type RuntimeEvolutionDeclaration = boolean | { configFile: string };
export type RuntimeEvolutionTrigger = {
  on: 'loop-iteration' | 'loop-end' | 'experiment-end' | 'after-step';
  every: number;
  step?: string;
};
export type RuntimeEvolutionBudget = {
  modelCalls?: number;
  timeoutSeconds?: number;
  evidenceBytes?: number;
};

export const runtimeEvolutionEvidenceViews = [
  'execution',
  'training',
  'training-summary',
] as const;
export type RuntimeEvolutionEvidenceView =
  (typeof runtimeEvolutionEvidenceViews)[number];

export type EvidenceDeclaration = {
  view?: RuntimeEvolutionEvidenceView;
  includeBindings?: string[];
  excludeBindings?: string[];
  includeSteps?: string[];
  excludeSteps?: string[];
};
type RuntimeEvolutionFile = {
  trigger?: Partial<RuntimeEvolutionTrigger>;
  evidence?: EvidenceDeclaration;
  implementation?: { contract?: string; ref?: string; config?: JsonObject };
  goal?: string;
  budget?: RuntimeEvolutionBudget;
};
export type MemoryConfiguration = RuntimeEvolutionFile & {
  directory?: string;
  targets?: { include?: string[]; exclude?: string[] };
};
export type ResourceSelection = Record<string, string[] | '*'>;
export type ReflectionConfiguration = RuntimeEvolutionFile & {
  targets: { include: ResourceSelection; exclude?: ResourceSelection };
};

const name = { type: 'string', minLength: 1, pattern: '\\S' };
export const runtimeEvolutionNames = {
  type: 'array',
  uniqueItems: true,
  items: name,
};
const positive = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
export const runtimeEvolutionTriggerSchema = {
  type: 'object',
  properties: {
    on: {
      enum: ['loop-iteration', 'loop-end', 'experiment-end', 'after-step'],
    },
    every: positive,
    step: name,
  },
  additionalProperties: false,
};
export const runtimeEvolutionDeclarationSchema: JsonObject = {
  oneOf: [
    { type: 'boolean' },
    {
      type: 'object',
      properties: { configFile: name },
      required: ['configFile'],
      additionalProperties: false,
    },
  ],
};
const common = {
  trigger: runtimeEvolutionTriggerSchema,
  evidence: {
    type: 'object',
    properties: {
      view: { enum: [...runtimeEvolutionEvidenceViews] },
      includeBindings: runtimeEvolutionNames,
      excludeBindings: runtimeEvolutionNames,
      includeSteps: runtimeEvolutionNames,
      excludeSteps: runtimeEvolutionNames,
    },
    additionalProperties: false,
  },
  goal: name,
  budget: {
    type: 'object',
    properties: {
      modelCalls: { ...positive, minimum: 0 },
      timeoutSeconds: { ...positive, maximum: Math.floor(2147483647 / 1000) },
      evidenceBytes: positive,
    },
    additionalProperties: false,
  },
};
export function runtimeEvolutionFileSchema(
  kind: RuntimeEvolutionKind,
): JsonObject {
  const resources: JsonObject = {
    type: 'object',
    additionalProperties: {
      oneOf: [
        { const: '*' },
        { const: ['*'] },
        {
          ...runtimeEvolutionNames,
          minItems: 1,
          items: { ...name, not: { const: '*' } },
        },
      ],
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    ...(kind === 'reflection' ? { required: ['targets'] } : {}),
    properties: {
      ...common,
      implementation: {
        type: 'object',
        properties: {
          contract: { const: 'contract.' + kind },
          ref: name,
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      ...(kind === 'memory' ? { directory: name } : {}),
      targets: {
        type: 'object',
        additionalProperties: false,
        ...(kind === 'memory'
          ? {
              properties: {
                include: runtimeEvolutionNames,
                exclude: runtimeEvolutionNames,
              },
            }
          : {
              required: ['include'],
              properties: {
                include: { ...resources, minProperties: 1 },
                exclude: resources,
              },
            }),
      },
    },
  };
}
