import type { JsonObject } from '../../contracts/index.js';
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

export const operatorEditConstraints = {
  allowedPaths: ['input.py'],
  maxChangedFiles: 1,
  maxChangedBytes: 32768,
};
export const operatorEditOutputSchema = recordSchema({
  edits: {
    type: 'array',
    maxItems: 1,
    items: recordSchema({
      path: { const: 'input.py' },
      content: { type: 'string', maxLength: 32768 },
    }),
  },
  reason: { type: 'string', maxLength: 4000 },
});

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
  similarityThreshold: number;
};
export type OperatorProposerConfig = {
  agentRef: string;
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
  diagnosisComplete?: boolean;
  experimentId: string;
  identity: OperatorAnalysisIdentity;
  baselineMs: number;
  issues: StaticIssue[];
  matches: StaticKnowledgeMatch[];
  knowledgeContext: string;
};
export type OperatorSummary = {
  schemaVersion: 'rsi.operator-summary/v1';
  summaryStatus?: 'available' | 'unavailable';
  experimentId: string;
  analysisRef: string;
  attempt: number;
  candidateRefs: string[];
  measurementRefs: string[];
  decisionRef: string | null;
  techniqueIds: StaticIssueType[];
  actionSummary: string;
  facts: {
    outcome: OperatorAttemptOutcome;
    wasTransformCorrect: boolean | null;
    baselineMs: number;
    candidateMs: number | null;
    accepted: boolean;
  };
  explanation: string;
  lessons: string[];
  avoidPatterns: string[];
  tryPatterns: string[];
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
const text: JsonObject = { type: 'string', minLength: 1, maxLength: 4000 };
const positive: JsonObject = { type: 'number', exclusiveMinimum: 0 };
const strings = (maximum: number): JsonObject => ({
  type: 'array',
  maxItems: maximum,
  items: text,
});
const refs = (minimum: number, maximum: number): JsonObject => ({
  type: 'array',
  minItems: minimum,
  maxItems: maximum,
  uniqueItems: true,
  items: ref,
});
export const configSchema = recordSchema(
  {
    agentRef: { ...ref, default: 'agent' },
    hardwareContextFile: { ...ref, 'x-rsi-path': 'file' },
    historyWindow: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    modelRequestTimeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 3600000,
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
          minimum: 1,
          maximum: 3600000,
          default: 300000,
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
  ['task', 'embedding'],
);
export const staticDiagnosisSchema: JsonObject = {
  type: 'array',
  maxItems: 16,
  uniqueItems: true,
  items: recordSchema({
    issue_type: { enum: [...staticIssueTypes] },
    issue_summary: text,
    problematic_code: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 32768 },
    },
    evidence: { ...strings(8), minItems: 1 },
  }),
};
export const diagnosisResponseSchema = recordSchema({
  issues: staticDiagnosisSchema,
});

export const analysisIdentitySchema = recordSchema({
  entryCandidateRef: ref,
  baselineMeasurementRef: ref,
  sourceDigest: hash,
  comparisonKey: hash,
  taskDigest: hash,
  contractDigest: hash,
  environmentDigest: hash,
  protocolDigest: hash,
  resourcesDigest: hash,
  embeddingDigest: hash,
  retrievalDigest: hash,
});
export const analysisSchema = recordSchema(
  {
    schemaVersion: { const: 'rsi.operator-analysis/v1' },
    diagnosisComplete: { type: 'boolean' },
    experimentId: ref,
    identity: analysisIdentitySchema,
    baselineMs: positive,
    issues: staticDiagnosisSchema,
    matches: {
      type: 'array',
      maxItems: 4,
      items: recordSchema({
        techniqueId: { enum: [...staticIssueTypes] },
        score: { type: 'number', minimum: -1, maximum: 1 },
        issueIndexes: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: 'integer', minimum: 0, maximum: 15 },
        },
        sourceReference: text,
        documentDigest: hash,
        exampleDigest: hash,
      }),
    },
    knowledgeContext: { type: 'string', maxLength: 20000 },
  },
  [
    'schemaVersion',
    'experimentId',
    'identity',
    'baselineMs',
    'issues',
    'matches',
    'knowledgeContext',
  ],
);
const summaryResponseProperties: JsonObject = {
  explanation: { type: 'string', maxLength: 4000 },
  lessons: strings(3),
  avoidPatterns: strings(3),
  tryPatterns: strings(3),
};
export const summaryResponseSchema = recordSchema(summaryResponseProperties);
export const summarySchema = recordSchema(
  {
    schemaVersion: { const: 'rsi.operator-summary/v1' },
    summaryStatus: { enum: ['available', 'unavailable'] },
    experimentId: ref,
    analysisRef: ref,
    attempt: { type: 'integer', minimum: 1, maximum: 3 },
    candidateRefs: refs(1, 4),
    measurementRefs: refs(0, 4),
    decisionRef: { anyOf: [ref, { type: 'null' }] },
    techniqueIds: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: { enum: [...staticIssueTypes] },
    },
    actionSummary: { type: 'string', maxLength: 4000 },
    facts: recordSchema({
      outcome: { enum: [...operatorAttemptOutcomes] },
      wasTransformCorrect: { type: ['boolean', 'null'] },
      baselineMs: positive,
      candidateMs: { anyOf: [positive, { type: 'null' }] },
      accepted: { type: 'boolean' },
    }),
    ...summaryResponseProperties,
  },
  [
    'schemaVersion',
    'experimentId',
    'analysisRef',
    'attempt',
    'candidateRefs',
    'measurementRefs',
    'decisionRef',
    'techniqueIds',
    'actionSummary',
    'facts',
    'explanation',
    'lessons',
    'avoidPatterns',
    'tryPatterns',
  ],
);
export const historySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-history/v1' },
  experimentId: ref,
  analysisRef: ref,
  summaryRefs: refs(0, 3),
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
  resourcesDigest: string;
  embeddingDigest: string;
  hardwareDigest: string | null;
  bottleneck: MetricsBottleneck | null;
  knowledgeContext: string;
  retrievalRef: string | null;
  retrievalStatus: 'skipped' | 'available' | 'unavailable';
};
export type MetricsSummary = {
  schemaVersion: 'rsi.operator-metrics-summary/v1';
  actionSummary: string;
  experimentId: string;
  round: number;
  analysisRef: string;
  parentCandidateRef: string;
  incumbentMeasurementRef: string;
  candidateRefs: string[];
  measurementRefs: string[];
  decisionRef: string | null;
  candidateDiagnosticMeasurementRef: string | null;
  facts: {
    outcome: OperatorAttemptOutcome;
    wasTransformCorrect: boolean | null;
    baselineMs: number;
    candidateMs: number | null;
    improvement: number | null;
    accepted: boolean;
    selectedCandidateRef: string;
  };
  summaryStatus: 'available' | 'unavailable';
  explanation: string;
  lessons: string[];
  avoidPatterns: string[];
  tryPatterns: string[];
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
    maxItems: 16,
    items: recordSchema({ path: ref, value: { type: 'number' } }),
  },
});
export const metricsAnalysisSchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-metrics-analysis/v1' },
  experimentId: ref,
  round: { type: 'integer', minimum: 1, maximum: 10 },
  parentCandidateRef: ref,
  incumbentMeasurementRef: ref,
  diagnosticMeasurementRef: ref,
  sourceDigest: hash,
  resourcesDigest: hash,
  embeddingDigest: hash,
  hardwareDigest: { anyOf: [hash, { type: 'null' }] },
  bottleneck: { anyOf: [metricsBottleneckSchema, { type: 'null' }] },
  knowledgeContext: { type: 'string', maxLength: 20000 },
  retrievalRef: { anyOf: [ref, { type: 'null' }] },
  retrievalStatus: { enum: ['skipped', 'available', 'unavailable'] },
});
export const metricsSummarySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-metrics-summary/v1' },
  actionSummary: { type: 'string', maxLength: 4000 },
  experimentId: ref,
  round: { type: 'integer', minimum: 1, maximum: 10 },
  analysisRef: ref,
  parentCandidateRef: ref,
  incumbentMeasurementRef: ref,
  candidateRefs: refs(0, 4),
  measurementRefs: refs(0, 4),
  decisionRef: { anyOf: [ref, { type: 'null' }] },
  candidateDiagnosticMeasurementRef: { anyOf: [ref, { type: 'null' }] },
  facts: recordSchema({
    outcome: { enum: [...operatorAttemptOutcomes] },
    wasTransformCorrect: { type: ['boolean', 'null'] },
    baselineMs: positive,
    candidateMs: { anyOf: [positive, { type: 'null' }] },
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
  summaryRefs: refs(0, 10),
});
