/** Read-only Web projections. These describe recorded facts, not inferred Policy state. */
export interface Page<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}
export interface ExperimentSummary {
  id: string;
  recipeId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
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
  callId: string;
  parentCallId: string | null;
  bindingId: string;
  pluginId: string;
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
  files: Page<{ path: string; bytes: number }> | null;
  content: JsonPreview | null;
  unavailable: string | null;
}
