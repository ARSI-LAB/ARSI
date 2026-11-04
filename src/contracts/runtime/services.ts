import type { Candidate } from '../models/candidate.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { EventPipeline } from './events.js';
import type {} from './context.js';

/** A detached observation, not a reservation for concurrent work. */
export type BudgetSnapshot = {
  limits: Record<string, number | null>;
  used: Record<string, number>;
  remaining: Record<string, number | null>;
  remainingWallMs: number;
};

export const budgetSnapshotSchema: JsonObject = {
  type: 'object',
  properties: {
    limits: {
      type: 'object',
      additionalProperties: { type: ['number', 'null'], minimum: 0 },
    },
    used: {
      type: 'object',
      additionalProperties: { type: 'number', minimum: 0 },
    },
    remaining: {
      type: 'object',
      additionalProperties: { type: ['number', 'null'], minimum: 0 },
    },
    remainingWallMs: { type: 'number', minimum: 0 },
  },
  required: ['limits', 'used', 'remaining', 'remainingWallMs'],
  additionalProperties: false,
};

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
    /** Reads settled usage without charging or changing facts; unlimited counters are null. */
    readBudget(this: RuntimeContext): Promise<BudgetSnapshot>;
    charge(this: RuntimeContext, metric: string, amount: number): Promise<void>;
    withInstance<T>(
      this: RuntimeContext,
      candidateRef: string,
      capability: string,
      use: (execution: JsonObject) => Promise<T>,
    ): Promise<T>;
  }
}
