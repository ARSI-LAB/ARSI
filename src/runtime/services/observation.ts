import {
  readAgentRecords,
  readAgentPayload,
  streamAgentPayload,
} from '../storage/agent-records.js';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  CallTrace,
  CallInstructions,
  ObservationSource,
} from '../../contracts/observation.js';
import type {
  ArtifactStore,
  FactStore,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import type {
  Page,
  ExperimentSummary,
  ExperimentPage,
  ExperimentOverview,
  CallSummary,
  CallDetail,
  CandidateSummary,
  MeasurementSummary,
  MetricObservation,
  MetricRecord,
  JsonPreview,
  ExperimentDetails,
  ResultReference,
  ArtifactPreview,
} from '../../contracts/observation.js';
import { object, string } from '../../shared/json.js';
import { redactText, secretValues } from '../../shared/secrets.js';
import { validate } from '../../shared/schema.js';
import { measurementItemsSchema } from '../../contracts/models/measurement.js';
import { parseFileTree } from '../../contracts/models/file-tree.js';
import { readIterationScopes } from '../../shared/iterations.js';
import { safeId } from '../storage/index.js';
import type { PolicyStructure } from '../../shared/observation/policy-structure.js';
import { queryPolicyStructure } from './policy-structure-query.js';
import { isExecutionActive } from '../manager/execution-lock.js';
import { isEvolutionInProgress, revisionDepths } from '../evolution/records.js';

function restrictedFile(path: string): boolean {
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.?netrc|credentials(?:\.json|\.ya?ml|\.toml)?|secrets?\.(?:json|ya?ml|toml)|id_(?:rsa|ed25519|ecdsa|dsa)|private[-_]?key(?:\.pem|\.key)?|[^/]+\.(?:p12|pfx))$/i.test(
    path,
  );
}

const secretField =
  /api[-_]?key|token|secret|password|authorization|credential/i;
/** Traverse recorded JSON without interpreting Policy-specific keys or exposing secret fields. */
function recordedStrings(
  value: JsonValue,
  path: string,
  visit: (value: string, path: string) => void,
): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value))
    value.forEach((child, index) =>
      recordedStrings(child, `${path}/${index}`, visit),
    );
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value))
      if (!secretField.test(key))
        recordedStrings(
          child,
          `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          visit,
        );
}
function optionalText(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function experimentPolicyRef(record: JsonObject): string | null {
  const policy = record.recipe ? object(record.recipe).policy : undefined;
  // Existing experiment snapshots use ref; current Recipes use id.
  return policy ? optionalText(object(policy).id ?? object(policy).ref) : null;
}
function numbers(value: JsonValue | undefined): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function page<T>(items: T[], offset: number, limit: number): Page<T> {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Invalid observation page');
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

/** Reads recorded facts without interpreting Policy outputs. */
export class ObservationQueries {
  constructor(
    private readonly facts: Pick<FactStore, 'read' | 'list' | 'scan'>,
    private readonly artifacts: Pick<ArtifactStore, 'readJson'>,
    private readonly directory?: string,
    private readonly pluginDescriptions?: () => (
      id: string,
    ) => string | undefined,
  ) {}

  source(): ObservationSource {
    return { directory: this.directory ? resolve(this.directory) : null };
  }

  /** The saved declaration only: no source files, artifact reads or resource restoration. */
  async policyStructure(id: string): Promise<PolicyStructure> {
    await this.experiment(id);
    return queryPolicyStructure(id, {
      readDefinition: () => this.facts.read('definitions', id),
      collectSecrets: async (locked) =>
        this.payloadSecrets(locked, await this.secrets(id)),
      clean: (value, secrets, redactKeys) =>
        this.clean(value, secrets, redactKeys),
      isSecretField: (field) => secretField.test(field),
      pluginDescriptions: this.pluginDescriptions,
    });
  }

  private async experiment(id: string): Promise<JsonObject> {
    return this.facts.read('experiments', safeId(id));
  }
  private async secrets(id: string): Promise<string[]> {
    const values = secretValues();
    const visit = (value: JsonValue): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (
          secretField.test(key) &&
          typeof item === 'string' &&
          item.length >= 4
        )
          values.push(item);
        visit(item);
      }
    };
    const experiment = await this.experiment(id);
    visit(experiment);
    let definition: JsonObject;
    try {
      definition = await this.facts.read('definitions', id);
    } catch (error) {
      if (missing(error)) return values;
      throw error;
    }
    const visited = new Set<string>();
    for (;;) {
      const retry = object(definition.retry ?? {});
      const ref = retry.previousDefinition;
      if (typeof ref !== 'string' || visited.has(ref)) break;
      visited.add(ref);
      definition = await this.facts.read('definition-attempts', ref);
      visit(definition);
    }
    return values;
  }
  private clean(
    value: JsonValue,
    secrets: string[],
    redactKeys = false,
  ): JsonValue {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value))
      return value.map((item) => this.clean(item, secrets, redactKeys));
    if (value && typeof value === 'object') {
      const keys = new Set<string>();
      return Object.fromEntries(
        Object.entries(value).map(([key, item], index) => {
          let label = redactKeys ? redactText(key, secrets) : key;
          while (keys.has(label)) label += ` (${index})`;
          keys.add(label);
          return [
            label,
            secretField.test(key)
              ? '[REDACTED]'
              : this.clean(item, secrets, redactKeys),
          ];
        }),
      );
    }
    return value;
  }
  private preview(
    value: JsonValue | undefined,
    secrets: string[],
  ): JsonPreview | null {
    if (value === undefined) return null;
    secrets = this.payloadSecrets(value, secrets);
    const text = JSON.stringify(this.clean(value, secrets), null, 2);
    return { text: text.slice(0, 32768), truncated: text.length > 32768 };
  }
  private payloadSecrets(value: JsonValue, known: string[]): string[] {
    const values = [...known];
    const visit = (item: JsonValue): void => {
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object')
        for (const [key, child] of Object.entries(item)) {
          if (
            secretField.test(key) &&
            typeof child === 'string' &&
            child.length >= 4
          )
            values.push(child);
          visit(child);
        }
    };
    visit(value);
    return values;
  }

  private async artifactRefs(id: string): Promise<Set<string>> {
    const refs = new Set<string>();
    const collect = (value: JsonValue): void => {
      recordedStrings(value, '', (ref) => {
        if (/^artifact:[a-f0-9]{64}$/.test(ref)) refs.add(ref);
      });
    };
    const experiment = await this.experiment(id);
    if (experiment.output !== undefined) collect(experiment.output);
    for (const kind of [
      'candidates',
      'measurements',
      'calls',
      'revisions',
      'memory-revisions',
      'evolution-runs',
    ] as const)
      for await (const entry of this.scanOwned(kind, id)) {
        if (kind === 'revisions') {
          if (entry.resourceRef) collect(entry.resourceRef);
        } else if (kind === 'memory-revisions') {
          if (entry.artifactRef) collect(entry.artifactRef);
          if (entry.changeRef) collect(entry.changeRef);
        } else if (kind === 'candidates') collect(entry.artifactRef!);
        else if (kind === 'calls') {
          if (entry.output !== undefined) collect(entry.output);
          if (entry.evidenceRef !== undefined) collect(entry.evidenceRef);
        } else collect(entry);
      }
    return refs;
  }

  /** Compact runtime evolution records; file contents use the existing bounded artifact projection. */
  private async evolutionPaths(id: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    for await (const run of this.scanOwned('evolution-runs', id)) {
      if (typeof run.triggerPath !== 'string') continue;
      if (typeof run.callId === 'string')
        paths.set(run.callId, run.triggerPath);
      paths.set(`evolution/${run.evolutionId}`, run.triggerPath);
    }
    return paths;
  }

  async evolution(
    id: string,
    collection: 'revisions' | 'memories',
  ): Promise<JsonObject[]> {
    const [secrets, runs, snapshots] = await Promise.all([
      this.secrets(id),
      this.owned('evolution-runs', id),
      this.owned(
        collection === 'memories' ? 'memory-revisions' : collection,
        id,
      ),
    ]);
    const memory = collection === 'memories';
    const depths = memory ? undefined : revisionDepths(snapshots);
    const attempts = new Map(
      runs
        .filter((run) => run.kind === (memory ? 'memory' : 'reflection'))
        .map((run) => [run.evolutionId, run]),
    );
    const artifacts = new Map(
      snapshots.map((snapshot) => [
        snapshot.ref,
        snapshot.artifactRef ?? snapshot.resourceRef,
      ]),
    );
    const records: JsonObject[] = snapshots.map((entry) => {
      const run = attempts.get(entry.evolutionId);
      if (memory) attempts.delete(entry.evolutionId);
      return {
        id: entry.ref ?? null,
        ...(memory
          ? { binding: 'memory' }
          : {
              ...(Array.isArray(entry.bindings)
                ? {
                    bindings: entry.bindings,
                    changedBindings: entry.changedBindings ?? [],
                  }
                : { binding: entry.binding ?? null }),
              depth: depths!.get(String(entry.ref)) ?? 0,
            }),
        kind: entry.kind ?? 'legacy',
        parentRef: entry.parentRef ?? null,
        parentArtifactRef:
          entry.parentArtifactRef ?? artifacts.get(entry.parentRef) ?? null,
        resourceRef: entry.artifactRef ?? entry.resourceRef ?? null,
        reason: entry.reason ?? run?.reason ?? null,
        status: run?.status ?? entry.status ?? 'unknown',
        path: run?.triggerPath ?? entry.triggerPath ?? null,
        startedAt: run?.startedAt ?? entry.startedAt ?? null,
        callId: run?.callId ?? entry.callId ?? null,
      };
    });
    if (memory)
      for (const run of attempts.values())
        records.push({
          id: run.evolutionId ?? null,
          binding: 'memory',
          kind: 'attempt',
          inProgress: isEvolutionInProgress(run.status),
          parentRef: run.parentRef ?? null,
          parentArtifactRef: run.parentArtifactRef ?? null,
          resourceRef: null,
          reason: run.reason ?? null,
          status: run.status ?? 'unknown',
          path: run.triggerPath ?? null,
          callId: run.callId ?? null,
          startedAt: run.startedAt ?? null,
        });
    records.sort(
      (a, b) =>
        Number(b.depth ?? 0) - Number(a.depth ?? 0) ||
        String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) ||
        String(a.id).localeCompare(String(b.id)),
    );
    return records.map((record) => object(this.clean(record, secrets)));
  }

  async assertRevision(id: string, ref: string): Promise<void> {
    await this.assertSnapshot('revisions', id, ref);
  }
  async assertMemory(id: string, ref: string): Promise<void> {
    await this.assertSnapshot('memories', id, ref);
  }
  private async assertSnapshot(
    collection: 'revisions' | 'memories',
    id: string,
    ref: string,
  ): Promise<void> {
    await this.experiment(id);
    const snapshot = await this.facts.read(
      collection === 'memories' ? 'memory-revisions' : collection,
      safeId(ref),
    );
    if (snapshot.experimentId !== id)
      throw Object.assign(new Error('Snapshot not found in experiment'), {
        statusCode: 404,
      });
  }

  /** Project application metadata without sending raw file bytes to the browser. */
  async applicationPreview(id: string, value: JsonObject): Promise<JsonObject> {
    return object(
      this.clean(
        {
          applicationAllowed: value.applicationAllowed ?? false,
          restrictions: value.restrictions ?? [],
          changes: value.changes ?? [],
          destinations: value.destinations ?? [],
        },
        await this.secrets(id),
      ),
    );
  }

  async details(id: string): Promise<ExperimentDetails> {
    const [record, secrets, candidates, measurements] = await Promise.all([
      this.experiment(id),
      this.secrets(id),
      this.owned('candidates', id),
      this.owned('measurements', id),
    ]);
    const result = this.preview(record.output, secrets);
    const candidateRefs = new Set(candidates.map((entry) => string(entry.ref)));
    const measurementRefs = new Set(
      measurements.map((entry) => string(entry.ref)),
    );

    const resultReferences: ResultReference[] = [];
    // Preserve direct result links when the full output exceeds the preview limit.
    let referenceSource: JsonValue | undefined = record.output;
    if (result?.truncated) {
      const output = record.output;
      referenceSource =
        output && typeof output === 'object' && !Array.isArray(output)
          ? Object.fromEntries(
              Object.entries(output).filter(
                ([, value]) => typeof value === 'string',
              ),
            )
          : undefined;
    }
    if (referenceSource !== undefined)
      recordedStrings(referenceSource, '', (ref, path) => {
        const kind = candidateRefs.has(ref)
          ? 'candidate'
          : measurementRefs.has(ref)
            ? 'measurement'
            : undefined;
        if (kind) resultReferences.push({ kind, ref, path });
      });
    return {
      configuration: this.preview(record.recipe, secrets),
      result,
      resultReferences,
    };
  }

  /** Access is limited to direct recorded links, never arbitrary artifact IDs or host paths. */
  async artifact(
    id: string,
    ref: string,
    path?: string,
    offset = 0,
    limit = 50,
  ): Promise<ArtifactPreview> {
    const candidates = await this.owned('candidates', id);
    if (
      !candidates.some((candidate) => candidate.artifactRef === ref) &&
      !(await this.artifactRefs(id)).has(ref)
    )
      throw Object.assign(new Error('Artifact not found in experiment'), {
        statusCode: 404,
      });
    const raw = await this.artifacts.readJson(ref),
      secrets = await this.secrets(id);
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.kind === 'file-tree'
    ) {
      const tree = parseFileTree(raw);
      const files = page(
        tree.files.map((file) => ({
          path: file.path,
          bytes: Buffer.byteLength(file.base64, 'base64'),
          ...(restrictedFile(file.path)
            ? {}
            : {
                digest: createHash('sha256')
                  .update(Buffer.from(file.base64, 'base64'))
                  .digest('hex'),
              }),
        })),
        offset,
        limit,
      );
      if (path === undefined)
        return {
          ref,
          kind: 'file-tree',
          files,
          content: null,
          unavailable: null,
        };
      const file = tree.files.find((entry) => entry.path === path);
      if (!file)
        throw Object.assign(new Error('File not found in artifact'), {
          statusCode: 404,
        });
      if (restrictedFile(path))
        return {
          ref,
          kind: 'file-tree',
          files,
          content: null,
          unavailable: 'Sensitive file content is restricted.',
        };
      if (file.base64.length > (1024 * 1024 * 4) / 3)
        return {
          ref,
          kind: 'file-tree',
          files,
          content: null,
          unavailable: 'File exceeds the 1 MiB text preview limit.',
        };
      const bytes = Buffer.from(file.base64, 'base64');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return {
          ref,
          kind: 'file-tree',
          files,
          content: null,
          unavailable: 'Binary content is not previewed.',
        };
      }
      if (text.includes('\0'))
        return {
          ref,
          kind: 'file-tree',
          files,
          content: null,
          unavailable: 'Binary content is not previewed.',
        };
      // Ordinary source and documentation are not credential assignments.
      // Replace confirmed secret values and embedded private keys only.
      text = redactText(text, secrets).replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        '[REDACTED]',
      );
      return {
        ref,
        kind: 'file-tree',
        files,
        content: { text: text.slice(0, 32768), truncated: text.length > 32768 },
        unavailable: null,
      };
    }
    if (path !== undefined)
      throw Object.assign(new Error('Artifact is not a file tree'), {
        statusCode: 400,
      });
    return {
      ref,
      kind: 'json',
      files: null,
      content: this.preview(raw, secrets),
      unavailable: null,
    };
  }

  private async summary(
    record: JsonObject,
    secrets: string[],
  ): Promise<ExperimentSummary> {
    return {
      id: string(record.id),
      recipeId: optionalText(record.recipeId),
      policyRef: experimentPolicyRef(record),
      status:
        record.status === 'running' &&
        !(await isExecutionActive(this.directory, string(record.id)))
          ? 'unconfirmed'
          : string(record.status),
      startedAt: optionalText(record.startedAt),
      finishedAt: optionalText(record.finishedAt),
      error:
        typeof record.error === 'string'
          ? redactText(record.error, secrets)
          : null,
    };
  }
  async experiments(
    offset = 0,
    limit = 50,
    policy?: string,
  ): Promise<ExperimentPage> {
    const entries = await this.facts.list('experiments');
    const policies = [
      ...new Set(
        entries.flatMap((entry) => {
          const ref = experimentPolicyRef(entry);
          return ref ? [ref] : [];
        }),
      ),
    ].sort();
    entries.sort(
      (a, b) =>
        String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) ||
        string(a.id).localeCompare(string(b.id)),
    );
    const selected = page(
      policy
        ? entries.filter((entry) => experimentPolicyRef(entry) === policy)
        : entries,
      offset,
      limit,
    );
    return {
      ...selected,
      policies,
      items: await Promise.all(
        selected.items.map(async (entry) =>
          this.summary(entry, await this.secrets(string(entry.id))),
        ),
      ),
    };
  }
  async overview(id: string): Promise<ExperimentOverview> {
    const record = await this.experiment(id),
      secrets = await this.secrets(id);
    let usage: Record<string, number> | null =
      record.usage === undefined ? null : numbers(record.usage);
    try {
      usage = numbers(await this.facts.read('budgets', id));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return {
      ...(await this.summary(record, secrets)),
      observedAt: new Date().toISOString(),
      usage,
      limits: numbers(record.recipe ? object(record.recipe).budget : undefined),
      output: this.preview(record.output, secrets),
    };
  }
  private readonly callScans = new Map<string, Promise<JsonObject[]>>();

  private async *scanOwned(
    kind: string,
    id: string,
  ): AsyncGenerator<JsonObject> {
    await this.experiment(id);
    const entries = this.facts.scan
      ? this.facts.scan(kind)
      : await this.facts.list(kind);
    for await (const entry of entries)
      if (entry.experimentId === id) yield entry;
  }

  /** Share concurrent scans; retain only list/provenance fields, never call payloads. */
  private compactCalls(id: string): Promise<JsonObject[]> {
    const pending = this.callScans.get(id);
    if (pending) return pending;
    const scan = async (): Promise<JsonObject[]> => {
      const records: JsonObject[] = [];
      for await (const entry of this.scanOwned('calls', id)) {
        const compact: JsonObject = {};
        for (const key of [
          'experimentId',
          'callId',
          'parentCallId',
          'bindingId',
          'memoryRef',
          'revisionRef',
          'pluginId',
          'contractId',
          'path',
          'status',
          'startedAt',
          'finishedAt',
          'error',
        ])
          if (entry[key] !== undefined) compact[key] = entry[key];
        const metadata = entry.metadata;
        if (
          metadata &&
          typeof metadata === 'object' &&
          !Array.isArray(metadata) &&
          typeof metadata.memoryVersionRef === 'string'
        )
          compact.memoryRef = metadata.memoryVersionRef;
        const output = entry.output;
        if (output && typeof output === 'object' && !Array.isArray(output)) {
          compact.output = {};
          for (const key of ['candidateRef', 'initialCandidateRef'])
            if (typeof output[key] === 'string')
              compact.output[key] = output[key];
          const batch = Array.isArray(output.candidates)
            ? output.candidates.map((item) =>
                item && typeof item === 'object' && !Array.isArray(item)
                  ? item.candidateRef
                  : null,
              )
            : Array.isArray(output.candidateRefs)
              ? output.candidateRefs
              : [];
          if (batch.length && batch.every((ref) => typeof ref === 'string'))
            compact.output.candidateRefs = batch;
        }
        records.push(compact);
      }
      return records;
    };
    const pendingScan = scan().finally(() => {
      this.callScans.delete(id);
    });
    this.callScans.set(id, pendingScan);
    return pendingScan;
  }

  private async owned(kind: string, id: string): Promise<JsonObject[]> {
    if (kind === 'calls') return this.compactCalls(id);
    const records: JsonObject[] = [];
    for await (const entry of this.scanOwned(kind, id)) records.push(entry);
    return records;
  }
  private call(
    record: JsonObject,
    secrets: string[],
    paths = new Map<string, string>(),
  ): CallSummary {
    return {
      callId: string(record.callId),
      parentCallId: optionalText(record.parentCallId),
      bindingId: string(record.bindingId),
      pluginId: string(record.pluginId),
      contractId: optionalText(record.contractId),
      path: optionalText(record.path),
      revisionRef: optionalText(record.revisionRef),
      memoryRef: optionalText(
        record.memoryRef ??
          (record.metadata &&
          typeof record.metadata === 'object' &&
          !Array.isArray(record.metadata)
            ? record.metadata.memoryVersionRef
            : null),
      ),
      triggerPath:
        record.bindingId === '_reflection' || record.bindingId === '_memory'
          ? (paths.get(String(record.callId)) ??
            paths.get(String(record.path)) ??
            null)
          : null,
      status: string(record.status),
      startedAt: optionalText(record.startedAt),
      finishedAt: optionalText(record.finishedAt),
      error:
        typeof record.error === 'string'
          ? redactText(record.error, secrets)
          : null,
    };
  }
  async calls(id: string, offset = 0, limit = 50): Promise<Page<CallSummary>> {
    const paths = await this.evolutionPaths(id);
    const entries = await this.owned('calls', id),
      secrets = await this.secrets(id);
    entries.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.callId).localeCompare(string(b.callId)),
    );
    const selected = page(entries, offset, limit);
    return {
      ...selected,
      items: selected.items.map((entry) => this.call(entry, secrets, paths)),
    };
  }
  async agentPayload(
    id: string,
    callId: string,
    ref: string,
  ): Promise<import('node:fs').ReadStream> {
    const call = await this.ownedCall(id, callId);
    const directory = this.agentCallDirectory(id, callId, call);
    if (!directory) throw new Error('Agent record storage is unavailable');
    return streamAgentPayload(directory, ref);
  }
  private agentCallDirectory(
    id: string,
    callId: string,
    call: JsonObject,
  ): string | null {
    return this.directory
      ? join(
          this.directory,
          'experiments',
          safeId(id),
          'calls',
          safeId(callId),
          ...(typeof call.attemptId === 'string'
            ? ['attempts', safeId(call.attemptId)]
            : []),
        )
      : null;
  }
  async callTrace(
    id: string,
    callId: string,
    offset = 0,
    limit = 50,
  ): Promise<CallTrace> {
    const call = await this.ownedCall(id, callId);
    const directory = this.agentCallDirectory(id, callId, call);
    if (!directory)
      return {
        ...page([], offset, limit),
        unavailable: 'Agent record storage is unavailable',
        recording: 'unavailable',
        incomplete: false,
        finalResponses: [],
      };
    try {
      const records = await readAgentRecords(
        directory,
        offset,
        limit,
        typeof call.finishedAt === 'string',
      );
      return {
        items: records.items.map((item) => ({
          sequence: item.sequence,
          at: item.recordedAt,
          type: item.type,
          runId: item.runId,
          native: item.native ?? null,
          event:
            item.type === 'task.submitted' ? { type: item.type } : item.event,
          payloadRef:
            item.type === 'task.submitted' ? null : (item.payload?.ref ?? null),
        })),
        total: records.total,
        nextOffset:
          records.nextAfter < records.total ? records.nextAfter : null,
        unavailable: null,
        recording: records.recording,
        incomplete: records.recording === 'interrupted' || records.gaps > 0,
        finalResponses: records.finalResponses,
      };
    } catch (error) {
      if (missing(error))
        return {
          ...page([], offset, limit),
          unavailable: 'No agent record has been saved for this call',
          recording: 'unavailable',
          incomplete: false,
          finalResponses: [],
        };
      throw error;
    }
  }
  private async ownedCall(id: string, callId: string): Promise<JsonObject> {
    const record = await this.facts.read('calls', safeId(callId));
    if (record.experimentId !== id)
      throw Object.assign(new Error('Call not found in experiment'), {
        statusCode: 404,
      });
    return record;
  }
  async callInstructions(
    id: string,
    callId: string,
    runId = 'main',
  ): Promise<CallInstructions> {
    const call = await this.ownedCall(id, callId);
    const directory = this.agentCallDirectory(id, callId, call);
    const [records, snapshot, knownSecrets] = await Promise.all([
      directory
        ? readAgentRecords(
            directory,
            0,
            1,
            typeof call.finishedAt === 'string',
            runId,
          ).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          })
        : null,
      typeof call.agentProjectArtifactRef === 'string'
        ? this.artifacts.readJson(call.agentProjectArtifactRef)
        : null,
      this.secrets(id),
    ]);
    const secrets = this.payloadSecrets(call.input ?? null, knownSecrets);
    const previewText = (value: string): JsonPreview => {
      const text = redactText(value, secrets).replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        '[REDACTED]',
      );
      return { text: text.slice(0, 32768), truncated: text.length > 32768 };
    };
    const submission = records?.submitted;
    const event =
      submission?.payload && directory
        ? object(
            JSON.parse(
              (
                await readAgentPayload(directory, submission.payload.ref)
              ).toString('utf8'),
            ),
          )
        : submission
          ? object(submission.event)
          : undefined;
    const instructionPaths = [
      'AGENTS.md',
      'CLAUDE.md',
      'context/instructions.md',
    ];
    const files = snapshot ? parseFileTree(snapshot).files : [];
    const delegation = records?.delegation;
    return {
      submittedTask:
        typeof event?.text === 'string' ? previewText(event.text) : null,
      delegation: delegation
        ? {
            parentRunId: delegation.parentRunId,
            sequence: delegation.sequence,
            message: delegation.message
              ? previewText(delegation.message)
              : null,
          }
        : null,
      outputSchema: this.preview(event?.outputSchema, secrets),
      workspaceInstructions: instructionPaths.flatMap((path) => {
        const file = files.find((entry) => entry.path === path);
        return file
          ? [
              {
                path,
                content: previewText(
                  Buffer.from(file.base64, 'base64').toString('utf8'),
                ),
              },
            ]
          : [];
      }),
    };
  }
  async callDetail(id: string, callId: string): Promise<CallDetail> {
    const secrets = await this.secrets(id),
      record = await this.ownedCall(id, callId);
    return {
      ...this.call(record, secrets, await this.evolutionPaths(id)),
      input: this.preview(record.input, secrets),
      output: this.preview(record.output, secrets),
    };
  }
  async candidates(
    id: string,
    offset = 0,
    limit = 50,
  ): Promise<Page<CandidateSummary>> {
    const [entries, calls] = await Promise.all([
      this.owned('candidates', id),
      this.owned('calls', id),
    ]);
    const byId = new Map(calls.map((call) => [string(call.callId), call]));
    const originsByRef = new Map<
      string,
      { call: JsonObject; batchPosition?: number }[]
    >();
    calls.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.callId).localeCompare(string(b.callId)),
    );
    for (const call of calls) {
      const output = call.output;
      if (!output || typeof output !== 'object' || Array.isArray(output))
        continue;
      const batch = Array.isArray(output.candidateRefs)
        ? output.candidateRefs
        : [];
      const addOrigin = (
        ref: JsonValue | undefined,
        batchPosition?: number,
      ) => {
        if (typeof ref !== 'string') return;
        const origins = originsByRef.get(ref) ?? [];
        origins.push({ call, batchPosition });
        originsByRef.set(ref, origins);
      };
      batch.forEach((ref, index) =>
        addOrigin(ref, batch.length > 1 ? index + 1 : undefined),
      );
      addOrigin(output.candidateRef);
      addOrigin(output.initialCandidateRef);
    }
    const paths = new Map<string, string | null>();
    const callPath = (origin: JsonObject): string | null => {
      let call: JsonObject | undefined = origin;
      const seen = new Set<string>();
      let path: string | null = null;
      while (call && !seen.has(string(call.callId))) {
        const callId = string(call.callId);
        if (paths.has(callId)) {
          path = paths.get(callId)!;
          break;
        }
        seen.add(callId);
        const recordedPath = optionalText(call.path);
        if (recordedPath && readIterationScopes(recordedPath).length) {
          path = recordedPath;
          break;
        }
        call =
          typeof call.parentCallId === 'string'
            ? byId.get(call.parentCallId)
            : undefined;
      }
      for (const callId of seen) paths.set(callId, path);
      return path;
    };
    const provenance = (ref: string) => {
      for (const origin of originsByRef.get(ref) ?? []) {
        const path = callPath(origin.call);
        if (path)
          return {
            originPath: path,
            batchPosition: origin.batchPosition,
          };
      }
      return { originPath: null };
    };

    entries.sort((a, b) => string(a.ref).localeCompare(string(b.ref)));
    const selected = page(entries, offset, limit);
    return {
      ...selected,
      items: selected.items.map((entry) => ({
        ref: string(entry.ref),
        parentRef: optionalText(entry.parentRef),
        artifactRef: string(entry.artifactRef),
        ...provenance(string(entry.ref)),
      })),
    };
  }

  private async metrics(
    rawMetrics: JsonValue,
    secrets: string[],
  ): Promise<MetricObservation[]> {
    return Promise.all(
      Object.entries(object(rawMetrics)).map(
        async ([name, raw]): Promise<MetricObservation> => {
          const metric = object(raw),
            definitionRef = string(metric.definitionRef);
          const definition = object(
            await this.artifacts.readJson(definitionRef),
          );
          const value = metric.value === null ? {} : object(metric.value);
          const values: Record<string, number | null> = {};
          for (const [key, number] of Object.entries(value))
            if (number === null || typeof number === 'number')
              values[key] = number;
          return {
            name,
            definitionRef,
            unit: string(definition.unit),
            description: redactText(string(definition.description), secrets),
            status: string(metric.status),
            reason:
              typeof metric.reason === 'string'
                ? redactText(metric.reason, secrets)
                : null,
            values,
          };
        },
      ),
    );
  }

  async metricRecords(
    id: string,
    offset = 0,
    limit = 50,
  ): Promise<Page<MetricRecord>> {
    const entries = await this.owned('measurements', id);
    entries.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.ref).localeCompare(string(b.ref)),
    );
    const records: { measurement: JsonObject; item: JsonObject | null }[] = [];
    for (const measurement of entries) {
      if (Object.keys(object(measurement.metrics)).length)
        records.push({ measurement, item: null });
      const list = await this.artifacts.readJson(string(measurement.itemsRef));
      validate(measurementItemsSchema, list, 'Measurement items');
      const items = object(list).items;
      if (!Array.isArray(items)) throw new Error('Measurement items missing');
      for (const raw of items) records.push({ measurement, item: object(raw) });
    }
    const selected = page(records, offset, limit);
    const secrets = await this.secrets(id);
    const items = await Promise.all(
      selected.items.map(
        async ({ measurement, item }): Promise<MetricRecord> => {
          const source = item ?? measurement;
          const subject = item ? object(item.subject) : null;
          return {
            ref: string(measurement.ref),
            candidateRef: string(measurement.candidateRef),
            callId: string(measurement.callId),
            status: string(source.status),
            coverage: string(source.coverage),
            comparisonKey: optionalText(source.comparisonKey),
            startedAt: optionalText(measurement.startedAt),
            finishedAt: optionalText(measurement.finishedAt),
            metrics: await this.metrics(source.metrics!, secrets),
            item:
              item && subject
                ? {
                    id: string(item.id),
                    subjectKind: string(subject.kind),
                    subjectId: string(subject.id),
                    parametersRef:
                      subject.parameters === null
                        ? null
                        : string(object(subject.parameters).artifactRef),
                  }
                : null,
          };
        },
      ),
    );
    return { ...selected, items };
  }

  async measurements(
    id: string,
    offset = 0,
    limit = 50,
    candidate?: string,
  ): Promise<Page<MeasurementSummary>> {
    let entries = await this.owned('measurements', id);
    if (candidate)
      entries = entries.filter((entry) => entry.candidateRef === candidate);
    entries.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.ref).localeCompare(string(b.ref)),
    );
    const selected = page(entries, offset, limit),
      secrets = await this.secrets(id);
    const items = await Promise.all(
      selected.items.map(async (entry): Promise<MeasurementSummary> => {
        const metrics = await this.metrics(entry.metrics!, secrets);
        return {
          diagnosticsRef: optionalText(entry.diagnosticsRef),
          ref: string(entry.ref),
          candidateRef: string(entry.candidateRef),
          callId: string(entry.callId),
          status: string(entry.status),
          coverage: string(entry.coverage),
          comparisonKey: optionalText(entry.comparisonKey),
          startedAt: optionalText(entry.startedAt),
          finishedAt: optionalText(entry.finishedAt),
          metrics,
        };
      }),
    );
    return { ...selected, items };
  }
}
