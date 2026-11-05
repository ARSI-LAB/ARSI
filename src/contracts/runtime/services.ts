import type { Candidate } from '../models/candidate.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { EventPipeline } from './events.js';
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
declare module './context.js' {
  interface RuntimeContext {
    readonly event: EventPipeline;
    rootDirectory: string;
    /** Stable local runtime data root; plugins own their subdirectories and cleanup. */
    dataDirectory: string;
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
    /** input.agentRef is a binding key, defaulting to the explicit agent.default binding. */
    invokeAgent(this: RuntimeContext, input: JsonObject): Promise<JsonObject>;
    readEvidence(
      this: RuntimeContext,
      refs: string[],
      options?: {
        format?: 'files';
        view?: 'execution' | 'training-summary' | 'delivery';
        /** Requested serialized-output budget, capped by Runtime and scope limits. */
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
  }
}
