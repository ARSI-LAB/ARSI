/** Read-only Web projections of recorded facts and current execution ownership. */
export interface Page<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}
export interface ExperimentSummary {
  id: string;
  recipeId: string | null;
  policyRef: string | null;
  /** Recorded status, with running projected as unconfirmed without a fresh execution lock. */
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export interface ExperimentPage extends Page<ExperimentSummary> {
  policies: string[];
}
export interface JsonPreview {
  text: string;
  truncated: boolean;
}
export interface ExperimentOverview extends ExperimentSummary {
  observedAt: string;
  usage: Record<string, number> | null;
  limits: Record<string, number>;
  output: JsonPreview | null;
}
export interface CallSummary {
  revisionRef?: string | null;
  memoryRef?: string | null;
  /** Persisted runtime evolution trigger location, separate from the call execution path. */
  triggerPath?: string | null;
  callId: string;
  parentCallId: string | null;
  bindingId: string;
  pluginId: string;
  contractId?: string | null;
  path: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export interface CallDetail extends CallSummary {
  input: JsonPreview | null;
  output: JsonPreview | null;
}
export interface CandidateSummary {
  /** One-based position in a recorded multi-candidate proposal. */
  batchPosition?: number;
  originPath?: string | null;
  ref: string;
  parentRef: string | null;
  artifactRef: string;
}
export interface MetricObservation {
  name: string;
  definitionRef: string;
  unit: string;
  description: string;
  status: string;
  reason: string | null;
  values: Record<string, number | null>;
}
export interface MeasurementSummary {
  /** Immutable diagnostics for this evaluation, even if its call later resumes. */
  diagnosticsRef?: string | null;
  ref: string;
  candidateRef: string;
  callId: string;
  status: string;
  coverage: string;
  comparisonKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: MetricObservation[];
}

/** A recorded aggregate or item observation; item conditions never inherit aggregate comparability. */
export interface MetricRecord extends MeasurementSummary {
  item: {
    id: string;
    subjectKind: string;
    subjectId: string;
    parametersRef: string | null;
  } | null;
}

/** Saved experiment content only; no live configuration or host filesystem reads. */
export interface ExperimentDetails {
  configuration: JsonPreview | null;
  result: JsonPreview | null;
  resultReferences: ResultReference[];
}
export interface ResultReference {
  kind: 'candidate' | 'measurement';
  ref: string;
  path: string;
}
export interface ArtifactPreview {
  ref: string;
  kind: 'json' | 'file-tree';
  files: Page<{ path: string; bytes: number; digest?: string }> | null;
  content: JsonPreview | null;
  unavailable: string | null;
}

/** Ordered structured Agent events; large content is referenced separately. */
export interface CallTrace
  extends Page<{
    sequence: number;
    at: string | null;
    type: string;
    runId: string;
    native: import('./json.js').JsonValue | null;
    event: import('./json.js').JsonValue | null;
    payloadRef: string | null;
  }> {
  unavailable: string | null;
  recording: 'open' | 'closed' | 'interrupted' | 'unavailable';
  incomplete: boolean;
  finalResponses: { runId: string; sequence: number }[];
}

export interface ObservationSource {
  directory: string | null;
  tracerUrl?: string;
}

export interface CallInstructions {
  submittedTask: JsonPreview | null;
  delegation: {
    parentRunId: string;
    sequence: number;
    message: JsonPreview | null;
  } | null;
  outputSchema: JsonPreview | null;
  workspaceInstructions: { path: string; content: JsonPreview }[];
}
