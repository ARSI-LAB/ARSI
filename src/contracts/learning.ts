import type { JsonObject } from './json.js';

export type LearningKind = 'memory' | 'reflection';
export type LearningDeclaration = boolean | { configFile: string };
export type LearningTrigger = {
  on: 'loop-iteration' | 'loop-end' | 'experiment-end' | 'after-step';
  every: number;
  step?: string;
};
export type LearningBudget = {
  modelCalls?: number;
  timeoutSeconds?: number;
  evidenceBytes?: number;
};

export type EvidenceDeclaration = {
  view?: 'execution' | 'training-summary';
  includeBindings?: string[];
  excludeBindings?: string[];
  includeSteps?: string[];
  excludeSteps?: string[];
};
type LearningFile = {
  trigger?: Partial<LearningTrigger>;
  evidence?: EvidenceDeclaration;
  implementation?: { contract?: string; ref?: string; config?: JsonObject };
  goal?: string;
  budget?: LearningBudget;
};
export type MemoryConfiguration = LearningFile & {
  directory?: string;
  targets?: { include?: string[]; exclude?: string[] };
};
export type ResourceSelection = Record<string, string[] | '*' | null>;
export type ReflectionConfiguration = LearningFile & {
  targets?: { include?: ResourceSelection; exclude?: ResourceSelection };
};

const name = { type: 'string', minLength: 1, pattern: '\\S' };
export const learningNames = { type: 'array', uniqueItems: true, items: name };
const positive = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
export const learningTriggerSchema = {
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
export const learningDeclarationSchema: JsonObject = {
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
function filter(selection: JsonObject): JsonObject {
  return {
    type: 'object',
    properties: { include: selection, exclude: selection },
    additionalProperties: false,
  };
}
const common = {
  trigger: learningTriggerSchema,
  evidence: {
    type: 'object',
    properties: {
      view: { enum: ['execution', 'training-summary'] },
      includeBindings: learningNames,
      excludeBindings: learningNames,
      includeSteps: learningNames,
      excludeSteps: learningNames,
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
export function learningFileSchema(kind: LearningKind): JsonObject {
  const resources: JsonObject = {
    type: 'object',
    additionalProperties: {
      oneOf: [learningNames, { const: '*' }, { type: 'null' }],
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
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
      ...(kind === 'memory'
        ? { directory: name, targets: filter(learningNames) }
        : { targets: filter(resources) }),
    },
  };
}
