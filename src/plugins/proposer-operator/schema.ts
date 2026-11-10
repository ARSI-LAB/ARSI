import type { Candidate, JsonObject } from '../../contracts/index.js';
import {
  operatorAttemptOutcomes,
  type OperatorAttemptOutcome,
} from '../../contracts/plugin-types/proposer-operator.js';
import { recordSchema } from '../../contracts/models/measurement.js';

export type OperatorAgentStage =
  | 'diagnose'
  | 'diagnose-metrics'
  | 'generate'
  | 'repair'
  | 'summarize';

export const defaultModelRequestTimeoutMs = 120000;

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

export const staticIssueTypes = [
  'core_partition',
  'pass_merge',
  'loop_invariant_hoisting',
  'masked_accumulator',
] as const;
export type StaticIssueType = (typeof staticIssueTypes)[number];
export type StaticIssue = {
  issue_type: StaticIssueType;
  issue_summary: string;
  problematic_code: string[];
  evidence: string[];
};
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
export type OperatorAnalysisIdentity = {
  entryCandidateRef: string;
  baselineMeasurementRef: string;
  sourceDigest: string;
  sourceBundleDigest: string;
  comparisonKey: string;
  taskDigest: string;
  contractDigest: string;
  environmentDigest: string;
  protocolDigest: string;
  resourcesDigest: string;
  embeddingDigest: string;
  retrievalDigest: string;
};
export type StaticKnowledgeMatch = {
  techniqueId: StaticIssueType;
  score: number;
  issueIndexes: number[];
  sourceReference: string;
  documentDigest: string;
  exampleDigest: string;
};
export type OperatorAnalysis = {
  schemaVersion: 'rsi.operator-analysis/v1';
  diagnosisComplete: boolean;
  experimentId: string;
  identity: OperatorAnalysisIdentity;
  baselineMs: number;
  issues: StaticIssue[];
  matches: StaticKnowledgeMatch[];
  knowledgeContext: string;
};
type AttemptFacts = {
  outcome: OperatorAttemptOutcome;
  wasTransformCorrect: boolean | null;
  baselineMs: number;
  candidateMs: number | null;
  accepted: boolean;
};
type SummaryContent = {
  experimentId: string;
  analysisRef: string;
  candidateRefs: string[];
  measurementRefs: string[];
  decisionRef: string | null;
  actionSummary: string;
  explanation: string;
  lessons: string[];
  avoidPatterns: string[];
  tryPatterns: string[];
};
export type OperatorSummary = SummaryContent & {
  schemaVersion: 'rsi.operator-summary/v1';
  summaryStatus: 'available' | 'unavailable';
  attempt: number;
  techniqueIds: StaticIssueType[];
  facts: AttemptFacts;
};
export type OperatorHistoryArtifact = {
  schemaVersion: 'rsi.operator-history/v1';
  experimentId: string;
  analysisRef: string;
  summaryRefs: string[];
};
/** Resolved summaries are derived by the reader; only summaryRefs are persisted. */
export type OperatorHistory = OperatorHistoryArtifact & {
  summaries: OperatorSummary[];
};
const ref: JsonObject = { type: 'string', minLength: 1 };
const hash: JsonObject = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text: JsonObject = { type: 'string', minLength: 1 };
const positive: JsonObject = { type: 'number', exclusiveMinimum: 0 };
const strings = (): JsonObject => ({
  type: 'array',
  items: text,
});
const refs = (minimum: number): JsonObject => ({
  type: 'array',
  minItems: minimum,
  uniqueItems: true,
  items: ref,
});
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
export const staticDiagnosisSchema: JsonObject = {
  type: 'array',
  uniqueItems: true,
  items: recordSchema({
    issue_type: { enum: [...staticIssueTypes] },
    issue_summary: text,
    problematic_code: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
    evidence: { ...strings(), minItems: 1 },
  }),
};
export const diagnosisResponseSchema = recordSchema({
  issues: staticDiagnosisSchema,
});

export const analysisIdentitySchema = recordSchema({
  entryCandidateRef: ref,
  baselineMeasurementRef: ref,
  sourceDigest: hash,
  sourceBundleDigest: hash,
  comparisonKey: hash,
  taskDigest: hash,
  contractDigest: hash,
  environmentDigest: hash,
  protocolDigest: hash,
  resourcesDigest: hash,
  embeddingDigest: hash,
  retrievalDigest: hash,
});
export const analysisSchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-analysis/v1' },
  diagnosisComplete: { type: 'boolean' },
  experimentId: ref,
  identity: analysisIdentitySchema,
  baselineMs: positive,
  issues: staticDiagnosisSchema,
  matches: {
    type: 'array',
    items: recordSchema({
      techniqueId: { enum: [...staticIssueTypes] },
      score: { type: 'number', minimum: -1, maximum: 1 },
      issueIndexes: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'integer', minimum: 0 },
      },
      sourceReference: text,
      documentDigest: hash,
      exampleDigest: hash,
    }),
  },
  knowledgeContext: { type: 'string' },
});
const assessmentFactProperties = {
  outcome: { enum: [...operatorAttemptOutcomes] },
  wasTransformCorrect: { type: ['boolean', 'null'] },
  baselineMs: positive,
  candidateMs: { anyOf: [positive, { type: 'null' }] },
};
const summaryReferenceProperties = {
  measurementRefs: refs(0),
  decisionRef: { anyOf: [ref, { type: 'null' }] },
};
const summaryResponseProperties: JsonObject = {
  explanation: { type: 'string' },
  lessons: strings(),
  avoidPatterns: strings(),
  tryPatterns: strings(),
};
export const summaryResponseSchema = recordSchema(summaryResponseProperties);
export const summarySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-summary/v1' },
  summaryStatus: { enum: ['available', 'unavailable'] },
  experimentId: ref,
  analysisRef: ref,
  attempt: { type: 'integer', minimum: 1 },
  candidateRefs: refs(1),
  ...summaryReferenceProperties,
  techniqueIds: {
    type: 'array',
    uniqueItems: true,
    items: { enum: [...staticIssueTypes] },
  },
  actionSummary: { type: 'string' },
  facts: recordSchema({
    ...assessmentFactProperties,
    accepted: { type: 'boolean' },
  }),
  ...summaryResponseProperties,
});
export const historySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-history/v1' },
  experimentId: ref,
  analysisRef: ref,
  summaryRefs: refs(0),
});

export type MetricsBottleneck = {
  category: 'scalar' | 'vector' | 'mte2' | 'mte3' | 'underutilized' | 'tiling';
  summary: string;
  reasoning: string;
  rootCause: string;
  recommendedFix: string;
  evidence: { path: string; value: number }[];
};
export type MetricsAnalysis = {
  schemaVersion: 'rsi.operator-metrics-analysis/v1';
  experimentId: string;
  round: number;
  parentCandidateRef: string;
  incumbentMeasurementRef: string;
  diagnosticMeasurementRef: string;
  sourceDigest: string;
  sourceBundleDigest: string;
  resourcesDigest: string;
  embeddingDigest: string;
  hardwareDigest: string | null;
  bottleneck: MetricsBottleneck | null;
  knowledgeContext: string;
  retrievalRef: string | null;
  retrievalStatus: 'skipped' | 'available' | 'unavailable';
};
export type MetricsSummary = SummaryContent & {
  schemaVersion: 'rsi.operator-metrics-summary/v1';
  round: number;
  parentCandidateRef: string;
  incumbentMeasurementRef: string;
  candidateDiagnosticMeasurementRef: string | null;
  facts: AttemptFacts & {
    improvement: number | null;
    selectedCandidateRef: string;
  };
  summaryStatus: 'available' | 'unavailable';
};
export type MetricsHistory = {
  schemaVersion: 'rsi.operator-metrics-history/v1';
  experimentId: string;
  summaryRefs: string[];
};
export const metricsBottleneckSchema = recordSchema({
  category: {
    enum: ['scalar', 'vector', 'mte2', 'mte3', 'underutilized', 'tiling'],
  },
  summary: text,
  reasoning: text,
  rootCause: text,
  recommendedFix: text,
  evidence: {
    type: 'array',
    minItems: 1,
    items: recordSchema({ path: ref, value: { type: 'number' } }),
  },
});
export const metricsAnalysisSchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-metrics-analysis/v1' },
  experimentId: ref,
  round: { type: 'integer', minimum: 1 },
  parentCandidateRef: ref,
  incumbentMeasurementRef: ref,
  diagnosticMeasurementRef: ref,
  sourceDigest: hash,
  sourceBundleDigest: hash,
  resourcesDigest: hash,
  embeddingDigest: hash,
  hardwareDigest: { anyOf: [hash, { type: 'null' }] },
  bottleneck: { anyOf: [metricsBottleneckSchema, { type: 'null' }] },
  knowledgeContext: { type: 'string' },
  retrievalRef: { anyOf: [ref, { type: 'null' }] },
  retrievalStatus: { enum: ['skipped', 'available', 'unavailable'] },
});
export const metricsSummarySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-metrics-summary/v1' },
  actionSummary: { type: 'string' },
  experimentId: ref,
  round: { type: 'integer', minimum: 1 },
  analysisRef: ref,
  parentCandidateRef: ref,
  incumbentMeasurementRef: ref,
  candidateRefs: refs(0),
  ...summaryReferenceProperties,
  candidateDiagnosticMeasurementRef: { anyOf: [ref, { type: 'null' }] },
  facts: recordSchema({
    ...assessmentFactProperties,
    improvement: { type: ['number', 'null'] },
    accepted: { type: 'boolean' },
    selectedCandidateRef: ref,
  }),
  summaryStatus: { enum: ['available', 'unavailable'] },
  ...summaryResponseProperties,
});
export const metricsHistorySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-metrics-history/v1' },
  experimentId: ref,
  summaryRefs: refs(0),
});

export type HardwareContext = { text: string; sha256: string };
export type OperatorResources = {
  digest: string;
  knowledgeDigest: string;
  workerDigest: string;
  prompts: Record<OperatorAgentStage, string>;
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

export type OperatorAttempt = {
  phase: 'static' | 'metrics';
  rootCandidateRef: string;
  baselineMeasurementRef: string;
  candidateRefs: string[];
  measurementRefs: string[];
  decisionRef: string | null;
  outcome: OperatorAttemptOutcome;
};

export type PreparedAttempt = {
  parent: Candidate;
  baseline: JsonObject;
  analysisRef: string;
  historyArtifact: OperatorHistoryArtifact | MetricsHistory;
  generationContext: JsonObject;
  summaryContext: JsonObject;
  generatePrompt: string;
  techniqueIds: OperatorSummary['techniqueIds'];
  noStaticIssues: boolean;
};

export type AnalysisReceipt = { analysisRef: string | null };
