import type { Candidate } from '../models/candidate.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { EventPipeline } from './events.js';
import type { AgentInput, AgentOutput } from '../plugin-types/agent.js';
import type {} from './context.js';

export interface ArtifactStore {
  putJson(value: unknown): Promise<string>;
  readJson(ref: string): Promise<JsonValue>;
  capture(directory: string): Promise<string>;
  materialize(ref: string, directory: string): Promise<void>;
}
export interface FactStore {
  read(kind: string, id: string): Promise<JsonObject>;
  write(kind: string, id: string, value: JsonObject): Promise<void>;
  list(kind: string): Promise<JsonObject[]>;
  /** Iterates facts without retaining all record bodies in memory. */
  scan?(kind: string): AsyncIterable<JsonObject>;
}
export interface Workspace {
  ref: string;
  directory: string;
  parentCandidateRef: string | null;
}
export interface WorkspaceService {
  create(artifactRef?: string, parentCandidateRef?: string): Promise<Workspace>;
  read(ref: string): Promise<Workspace>;
  release(ref: string): Promise<void>;
}
/** Presentation-only progress observation for the active call; never persisted as experiment facts. */
export interface CallProgressUpdate {
  readonly detail?: string;
  readonly lines?: readonly string[];
  readonly notice?: string;
  /** Additional display text for a notice in verbose mode. */
  readonly verboseNotice?: string;
  readonly level?: 'info' | 'warning' | 'error';
}
declare module './context.js' {
  interface RuntimeContext<C extends JsonObject = JsonObject> {
    readonly event: EventPipeline<C>;
    rootDirectory: string;
    /** Stable local runtime data root; plugins own their subdirectories and cleanup. */
    dataDirectory: string;
    /** Prepared input project shared with native delegates. */
    agentProject?: string;
    runAgentProcess(
      this: RuntimeContext,
      spec: import('./agent-execution.js').AgentProcessSpec,
      onLine: import('./agent-execution.js').AgentLineHandler,
    ): Promise<void>;
    artifacts: ArtifactStore;
    facts: FactStore;
    workspaces: WorkspaceService;
    readCandidate(this: RuntimeContext, ref: string): Promise<Candidate>;
    recordCandidate(
      this: RuntimeContext,
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string>;
    recordMeasurement(
      this: RuntimeContext,
      measurement: JsonObject,
    ): Promise<string>;
    readMeasurement(this: RuntimeContext, ref: string): Promise<JsonObject>;
    application(this: RuntimeContext, input: JsonObject): Promise<JsonObject>;
    applicationMetadata(this: RuntimeContext): Promise<JsonObject>;
    /** Run an Agent using the specified Recipe binding. */
    invokeAgent(
      this: RuntimeContext,
      agentRef: string,
      input: AgentInput,
    ): Promise<AgentOutput>;
    readEvidence(
      this: RuntimeContext,
      refs: string[],
      options?: {
        format?: 'files';
        view?: 'execution' | 'training-summary' | 'delivery';
        /** Requested serialized-output budget. JSON projections and scoped reads may apply a lower limit. */
        maxBytes?: number;
      },
    ): Promise<JsonValue>;
    invoke(
      this: RuntimeContext,
      binding: string,
      input: JsonValue,
    ): Promise<JsonValue>;
    charge(this: RuntimeContext, metric: string, amount: number): Promise<void>;
    withInstance<T>(
      this: RuntimeContext,
      candidateRef: string,
      capability: string,
      use: (execution: JsonObject) => Promise<T>,
    ): Promise<T>;
    /** Best-effort presentation-only progress update for the active call. */
    reportProgress?(this: RuntimeContext, update: CallProgressUpdate): void;
  }
}
