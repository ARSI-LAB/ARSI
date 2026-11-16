import type { Candidate, JsonObject } from '../../contracts/index.js';

import { recordSchema } from '../../contracts/models/measurement.js';

import {
  staticIssueTypes,
  defaultModelRequestTimeoutMs,
  type StaticKnowledgeMatch,
  type StaticIssue,
  type OperatorAgentStage,
} from '../shared/operator-attempt/schema.js';
export function operatorEditOutputSchema(editablePaths: string[]): JsonObject {
  return recordSchema({
    edits: {
      type: 'array',
      maxItems: editablePaths.length,
      items: recordSchema({
        path: { enum: editablePaths },
        content: { type: 'string' },
      }),
    },
    reason: { type: 'string' },
  });
}

export type EmbeddingConfig = {
  resourcesDirectory: string;
  retrievalScript: string;
  python: string;
  modelDirectory: string;
  identityFile: string;
  device: 'cpu';
  timeoutMs: number;
  maxPayloadBytes?: number;
  maxLogBytes?: number;
  similarityThreshold: number;
};
export type OperatorProposerConfig = {
  agentRef: string;
  promptsDirectory: string;
  hardwareContextFile?: string;
  historyWindow?: number;
  modelRequestTimeoutMs?: number;
  task: { directory: string };
  embedding: EmbeddingConfig;
};

const ref: JsonObject = { type: 'string', minLength: 1 };
const hash: JsonObject = { type: 'string', pattern: '^[a-f0-9]{64}$' };

export const configSchema = recordSchema(
  {
    agentRef: { ...ref, default: 'agent' },
    promptsDirectory: { ...ref, 'x-rsi-path': 'directory' },
    hardwareContextFile: { ...ref, 'x-rsi-path': 'file' },
    historyWindow: { type: 'integer', minimum: 0, default: 5 },
    modelRequestTimeoutMs: {
      type: 'integer',
      minimum: 0,
      maximum: 2147483647,
      default: defaultModelRequestTimeoutMs,
    },
    task: recordSchema({ directory: { ...ref, 'x-rsi-path': 'directory' } }),
    embedding: recordSchema(
      {
        python: ref,
        resourcesDirectory: { ...ref, 'x-rsi-path': 'directory' },
        retrievalScript: { ...ref, 'x-rsi-path': 'file' },
        modelDirectory: ref,
        identityFile: { ...ref, 'x-rsi-path': 'file' },
        device: { const: 'cpu', default: 'cpu' },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          default: 300000,
        },
        maxPayloadBytes: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        maxLogBytes: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        similarityThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.6,
        },
      },
      [
        'python',
        'modelDirectory',
        'identityFile',
        'resourcesDirectory',
        'retrievalScript',
      ],
    ),
  },
  ['promptsDirectory', 'task', 'embedding'],
);

export type HardwareContext = { text: string; sha256: string };
export type OperatorResources = {
  digest: string;
  knowledgeDigest: string;
  workerDigest: string;
  prompts: Record<Exclude<OperatorAgentStage, 'summarize'>, string>;
  metricsGenerate: string;
  guidelines: string;
};
export type EmbeddingIdentity = {
  schemaVersion: 'rsi.operator-embedding-identity/v1';
  model: { id: string; revision: string };
  encoding: {
    queryPromptName: 'query';
    normalizeEmbeddings: true;
    device: 'cpu';
    batchSize: number;
  };
  files: { path: string; sha256: string }[];
};
export type MetricsKnowledgeMatch = Omit<
  StaticKnowledgeMatch,
  'techniqueId' | 'exampleDigest'
> & { techniqueId: string; exampleDigest: string | null };
export type OperatorRetrievalResult<Match extends MetricsKnowledgeMatch> = {
  schemaVersion: 'rsi.operator-retrieval/v1';
  workerDigest: string;
  embeddingDigest: string;
  resourcesDigest: string;
  matches: Match[];
  knowledgeContext: string;
  omitted: { techniques: string[]; examples: string[] };
  model: { id: string; revision: string };
  runtime: {
    python: string;
    sentenceTransformers: string;
    transformers: string;
    torch: string;
  };
};
export type StaticRetrievalResult =
  OperatorRetrievalResult<StaticKnowledgeMatch>;
export type MetricsRetrievalResult =
  OperatorRetrievalResult<MetricsKnowledgeMatch>;
export type KnowledgeResources = {
  manifest: JsonObject;
  resources: Map<string, string>;
  digest: string;
  workerDigest: string;
  guidelines: string;
};
export type KnowledgeQuery =
  | { issues: StaticIssue[] }
  | { mode: 'metrics'; query: string };
const retrievalText = { type: 'string', minLength: 1 };
export const embeddingIdentitySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-embedding-identity/v1' },
  model: recordSchema({ id: retrievalText, revision: retrievalText }),
  encoding: recordSchema({
    queryPromptName: { const: 'query' },
    normalizeEmbeddings: { const: true },
    device: { const: 'cpu' },
    batchSize: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  }),
  files: {
    type: 'array',
    minItems: 1,
    items: recordSchema({ path: retrievalText, sha256: hash }),
  },
});
const retrievalMatch = {
  score: { type: 'number', minimum: -1, maximum: 1 },
  sourceReference: retrievalText,
  documentDigest: hash,
};
const retrievalResult = {
  schemaVersion: { const: 'rsi.operator-retrieval/v1' },
  embeddingDigest: hash,
  resourcesDigest: hash,
  knowledgeContext: { type: 'string' },
  model: recordSchema({ id: retrievalText, revision: retrievalText }),
  runtime: recordSchema({
    python: retrievalText,
    sentenceTransformers: retrievalText,
    transformers: retrievalText,
    torch: retrievalText,
  }),
};
export const staticRetrievalSchema = recordSchema({
  ...retrievalResult,
  matches: {
    type: 'array',
    items: recordSchema({
      ...retrievalMatch,
      techniqueId: { enum: [...staticIssueTypes] },
      exampleDigest: hash,
      issueIndexes: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'integer', minimum: 0 },
      },
    }),
  },
  omitted: recordSchema({
    techniques: {
      type: 'array',
      uniqueItems: true,
      items: { enum: [...staticIssueTypes] },
    },
    examples: {
      type: 'array',
      uniqueItems: true,
      items: { enum: [...staticIssueTypes] },
    },
  }),
});
export const metricsRetrievalSchema = recordSchema({
  ...retrievalResult,
  matches: {
    type: 'array',
    items: recordSchema({
      ...retrievalMatch,
      techniqueId: retrievalText,
      exampleDigest: { anyOf: [hash, { type: 'null' }] },
      issueIndexes: {
        type: 'array',
        minItems: 1,
        maxItems: 1,
        items: { const: 0 },
      },
    }),
  },
  omitted: recordSchema({
    techniques: { type: 'array', items: retrievalText },
    examples: { type: 'array', items: retrievalText },
  }),
});

export type PreparedAttempt = {
  parent: Candidate;
  baseline: JsonObject;
  analysisRef: string;
  generationContext: JsonObject;
  generatePrompt: string;
  noChange: {
    reasonCode: 'no-static-issues' | 'no-new-hypothesis';
    rationale: string;
  } | null;
};

export type AnalysisReceipt = { analysisRef: string | null };
