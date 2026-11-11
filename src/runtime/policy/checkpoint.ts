import type {
  FactStore,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { object, string, unknownKeys } from '../../shared/json.js';

export interface PolicyCheckpointChange {
  identity: string;
  kind: 'step' | 'boundary';
  path: string;
  value: JsonValue;
}
export interface IncrementalPolicyCheckpoint {
  /** Resolves only after the entry and its commit pointer are durable. */
  append(change: PolicyCheckpointChange): Promise<void>;
}
export const checkpointVersion = 'rsi.policy-checkpoint/v1';
export function readPolicyCheckpoint(
  value: JsonObject,
  identity?: string,
): { journal: JsonObject; boundaries: JsonObject } {
  if (value.schemaVersion !== checkpointVersion)
    throw new Error('Policy checkpoint format is unsupported');
  unknownKeys(
    value,
    ['schemaVersion', 'identity', 'journal', 'boundaries'],
    'Policy checkpoint',
  );
  string(value.identity, 'checkpoint.identity');
  if (identity !== undefined && value.identity !== identity)
    throw new Error('Policy checkpoint identity differs from locked inputs');
  const journal = structuredClone(object(value.journal, 'checkpoint.journal'));
  const boundaries = structuredClone(
    object(value.boundaries, 'checkpoint.boundaries'),
  );
  for (const [path, raw] of Object.entries(journal))
    validateCheckpointStep(path, raw);
  for (const [path, complete] of Object.entries(boundaries))
    validateCheckpointBoundary(path, complete);
  return { journal, boundaries };
}

export function validateCheckpointStep(path: string, raw: JsonValue): void {
  if (!path.startsWith('steps/'))
    throw new Error(`checkpoint.journal: invalid step path ${path}`);
  const record = object(raw, `checkpoint.journal.${path}`);
  unknownKeys(record, ['result', 'patch'], `checkpoint.journal.${path}`);
  object(record.patch, 'checkpoint.patch');
  const result = object(record.result, 'checkpoint.result');
  if (result.kind === 'completed') {
    unknownKeys(result, ['kind', 'output'], 'checkpoint.result');
    if (result.output === undefined)
      throw new Error('checkpoint.result.output is required');
  } else if (result.kind === 'break' || result.kind === 'continue')
    unknownKeys(result, ['kind'], 'checkpoint.result');
  else throw new Error('checkpoint.result.kind is invalid');
}

export function validateCheckpointBoundary(
  path: string,
  complete: JsonValue,
): void {
  if (
    complete !== true ||
    (path !== 'policy-completed' && !/^steps\/.+\/iteration-\d+$/.test(path))
  )
    throw new Error(`checkpoint.boundaries: invalid boundary ${path}`);
}

const headVersion = 'rsi.policy-checkpoint/v2';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** One Manager execution owns each adapter. Entry facts precede their atomic commit head. */
export class PolicyCheckpoints implements IncrementalPolicyCheckpoint {
  private entries = 0;
  private identity: string | undefined;
  private baseline: JsonObject | undefined;
  private hasBaseline = false;
  private initialized = false;
  private queue = Promise.resolve();

  constructor(
    private readonly facts: FactStore,
    private readonly id: string,
  ) {}

  /** Reconstructs the committed prefix; an orphan beyond the head remains uncommitted. */
  async restore(): Promise<JsonObject | undefined> {
    let head: JsonObject;
    try {
      head = await this.facts.read('checkpoints', this.id);
    } catch (error) {
      if (!missing(error)) throw error;
      this.entries = 0;
      this.identity = undefined;
      this.baseline = undefined;
      this.hasBaseline = false;
      this.initialized = true;
      return undefined;
    }
    if (head.schemaVersion === checkpointVersion) {
      readPolicyCheckpoint(head);
      this.identity = string(head.identity, 'checkpoint.identity');
      this.entries = 0;
      this.baseline = structuredClone(head);
      this.hasBaseline = true;
      this.initialized = true;
      return structuredClone(head);
    }
    unknownKeys(
      head,
      ['schemaVersion', 'identity', 'entries', 'baseline'],
      'checkpoint head',
    );
    if (head.schemaVersion !== headVersion)
      throw new Error('Policy checkpoint format is unsupported');
    const identity = string(head.identity, 'checkpoint head.identity');
    const entries = head.entries;
    if (
      typeof entries !== 'number' ||
      !Number.isSafeInteger(entries) ||
      entries < 1
    )
      throw new Error(
        'checkpoint head.entries must be a positive safe integer',
      );
    if (typeof head.baseline !== 'boolean')
      throw new Error('checkpoint head.baseline must be boolean');
    let journal: JsonObject = {};
    let boundaries: JsonObject = {};
    if (head.baseline) {
      const snapshot = await this.facts.read(
        'checkpoint-entries',
        `${this.id}.baseline`,
      );
      ({ journal, boundaries } = readPolicyCheckpoint(snapshot, identity));
    }
    for (let sequence = 0; sequence < entries; sequence++) {
      const entry = await this.facts.read(
        'checkpoint-entries',
        `${this.id}.${sequence}`,
      );
      unknownKeys(
        entry,
        ['identity', 'sequence', 'kind', 'path', 'value'],
        'checkpoint entry',
      );
      if (entry.identity !== identity || entry.sequence !== sequence)
        throw new Error(
          'Policy checkpoint entry identity or sequence mismatch',
        );
      const path = string(entry.path, 'checkpoint entry.path');
      if (entry.value === undefined)
        throw new Error('checkpoint entry.value is required');
      if (entry.kind === 'step') {
        validateCheckpointStep(path, entry.value);
        journal[path] = entry.value;
      } else if (entry.kind === 'boundary') {
        validateCheckpointBoundary(path, entry.value);
        boundaries[path] = entry.value;
      } else throw new Error('checkpoint entry.kind is invalid');
    }
    const snapshot = {
      schemaVersion: checkpointVersion,
      identity,
      journal,
      boundaries,
    };
    readPolicyCheckpoint(snapshot, identity);
    this.identity = identity;
    this.entries = entries;
    this.hasBaseline = head.baseline;
    this.baseline = undefined;
    this.initialized = true;
    return snapshot;
  }

  async restoreOrdered(): Promise<JsonObject | undefined> {
    const snapshot = await this.restore();
    // Legacy snapshot journals were sorted by path when serialized.
    return this.hasBaseline ? undefined : snapshot;
  }

  async append(change: PolicyCheckpointChange): Promise<void> {
    const owned = structuredClone(change);
    string(owned.identity, 'checkpoint entry.identity');
    string(owned.path, 'checkpoint entry.path');
    if (owned.kind === 'step') validateCheckpointStep(owned.path, owned.value);
    else if (owned.kind === 'boundary')
      validateCheckpointBoundary(owned.path, owned.value);
    else throw new Error('checkpoint entry.kind is invalid');
    this.queue = this.queue.then(async () => {
      if (!this.initialized) await this.restore();
      if (this.identity !== undefined && this.identity !== owned.identity)
        throw new Error(
          'Policy checkpoint identity differs from locked inputs',
        );
      if (this.baseline) {
        await this.facts.write(
          'checkpoint-entries',
          `${this.id}.baseline`,
          this.baseline,
        );
      }
      const sequence = this.entries;
      await this.facts.write('checkpoint-entries', `${this.id}.${sequence}`, {
        ...owned,
        sequence,
      });
      await this.facts.write('checkpoints', this.id, {
        schemaVersion: headVersion,
        identity: owned.identity,
        entries: sequence + 1,
        baseline: this.hasBaseline,
      });
      this.entries = sequence + 1;
      this.identity = owned.identity;
      this.baseline = undefined;
    });
    await this.queue;
  }
}
