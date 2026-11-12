import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
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
import type { PolicyStructure } from '../../contracts/policy-structure.js';
import {
  DefinitionLockError,
  readDefinitionLock,
} from '../manager/definition-lock.js';
import {
  projectPolicyStructure,
  unavailablePolicyStructure,
  policyStructureLimits,
} from '../compiler/policy-structure.js';

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

/** Redact source text and identities consistently, keeping protocol enums intact. */
function redactStructureStrings(
  model: PolicyStructure,
  secrets: string[],
): PolicyStructure {
  const text = (value: string): string => redactText(value, secrets);
  // Redaction must not collapse distinct endpoint identities into one placeholder.
  const identity = (value: string): string =>
    text(value) === value
      ? value
      : `redacted:${createHash('sha256').update(value).digest('hex')}`;
  const optional = (value: string | null): string | null =>
    value === null ? null : text(value);
  const optionalIdentity = (value: string | null): string | null =>
    value === null ? null : identity(value);
  return {
    ...model,
    source: {
      ...model.source,
      experimentId: text(model.source.experimentId),
      policyId: optional(model.source.policyId),
      definitionDigest: optional(model.source.definitionDigest),
    },
    steps: model.steps.map((step) => ({
      ...step,
      id: identity(step.id),
      localId: text(step.localId),
      label: text(step.label),
      location: text(step.location),
      scopeId: identity(step.scopeId),
      childScopeIds: step.childScopeIds.map(identity),
      detailId: identity(step.detailId),
    })),
    scopes: model.scopes.map((scope) => ({
      ...scope,
      id: identity(scope.id),
      parentStepId: optionalIdentity(scope.parentStepId),
      location: text(scope.location),
      stepIds: scope.stepIds.map(identity),
      entryId: identity(scope.entryId),
      exitId: identity(scope.exitId),
    })),
    flow: {
      nodes: model.flow.nodes.map((node) => ({
        ...node,
        id: identity(node.id),
        stepId: optionalIdentity(node.stepId),
        scopeId: identity(node.scopeId),
        label: text(node.label),
      })),
      edges: model.flow.edges.map((edge) => ({
        ...edge,
        id: identity(edge.id),
        source: identity(edge.source),
        target: identity(edge.target),
        label: optional(edge.label),
        location: text(edge.location),
      })),
    },
    data: {
      nodes: model.data.nodes.map((node) => ({
        ...node,
        id: identity(node.id),
        stepId: optionalIdentity(node.stepId),
        scopeId: identity(node.scopeId),
        detailId: identity(node.detailId),
        label: text(node.label),
        ports: node.ports.map((port) => ({
          ...port,
          id: identity(port.id),
          label: text(port.label),
          path: port.path.map(text),
          location: text(port.location),
        })),
      })),
      edges: model.data.edges.map((edge) => ({
        ...edge,
        id: identity(edge.id),
        source: {
          nodeId: identity(edge.source.nodeId),
          portId: identity(edge.source.portId),
        },
        target: {
          nodeId: identity(edge.target.nodeId),
          portId: identity(edge.target.portId),
        },
        label: optional(edge.label),
        location: text(edge.location),
      })),
    },
    details: model.details.map((detail) => ({
      ...detail,
      id: identity(detail.id),
      bindingId: optionalIdentity(detail.bindingId),
      expressionPreviews: detail.expressionPreviews
        ?.filter(
          (preview) =>
            preview.kind !== 'range' ||
            [preview.start, preview.end].every(
              (bound) => text(String(bound)) === String(bound),
            ),
        )
        .map((preview) => ({
          ...preview,
          location: text(preview.location),
          ...(preview.kind === 'config'
            ? { path: preview.path.map(text) }
            : {}),
        })),
    })),
    bindings: model.bindings.map((binding) => ({
      ...binding,
      id: identity(binding.id),
      name: text(binding.name),
      contract: optional(binding.contract),
      plugin: optional(binding.plugin),
    })),
    diagnostics: model.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      nodeId: optionalIdentity(diagnostic.nodeId),
      location: optional(diagnostic.location),
      message: text(diagnostic.message),
    })),
  };
}

/** Reads through existing stores; never writes facts, executes plugins, or interprets Policy outputs. */
export class ObservationQueries {
  constructor(
    private readonly facts: Pick<FactStore, 'read' | 'list' | 'scan'>,
    private readonly artifacts: Pick<ArtifactStore, 'readJson'>,
    private readonly directory?: string,
  ) {}

  source(): ObservationSource {
    return { directory: this.directory ? resolve(this.directory) : null };
  }

  /** The initial saved declaration only: no source files, artifact reads or resource restoration. */
  async policyStructure(id: string): Promise<PolicyStructure> {
    await this.experiment(id);
    let locked: JsonObject;
    try {
      locked = await this.facts.read('definitions', id);
    } catch (error) {
      if (missing(error))
        return unavailablePolicyStructure(
          id,
          'missing-source',
          'No initial saved definition is available for this experiment.',
        );
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          /^(value: expected object|Expected finite JSON data|Forbidden key (?:__proto__|constructor|prototype))$/.test(
            error.message,
          ))
      )
        return unavailablePolicyStructure(
          id,
          'invalid-source',
          'The saved definition is not valid JSON.',
        );
      throw error;
    }
    // Bound analysis before parsing recursive templates; never return a silently shortened graph.
    if (
      Buffer.byteLength(JSON.stringify(locked), 'utf8') >
      policyStructureLimits.bytes
    )
      return unavailablePolicyStructure(
        id,
        'oversized',
        'The saved definition exceeds the 4 MiB visualization limit.',
      );
    const secrets = this.payloadSecrets(locked, await this.secrets(id));
    let source: ReturnType<typeof readDefinitionLock>;
    try {
      source = readDefinitionLock(locked);
    } catch (error) {
      if (error instanceof DefinitionLockError)
        return unavailablePolicyStructure(id, error.category, error.message);
      throw error;
    }
    const config = object(source.recipe.policy).config;
    const model = projectPolicyStructure(
      { experimentId: id, ...source },
      {
        config: config === undefined ? undefined : this.clean(config, secrets),
        isVisible: (value, location) =>
          redactText(value, secrets) === value &&
          redactText(location, secrets) === location &&
          !location.split('/').some((segment) => secretField.test(segment)),
      },
    );
    for (const detail of model.details) {
      detail.declaration = this.clean(detail.declaration, secrets, true);
      detail.configuration = this.clean(detail.configuration, secrets, true);
      detail.expressionPreviews = detail.expressionPreviews?.map((preview) =>
        preview.kind === 'value'
          ? { ...preview, value: this.clean(preview.value, secrets, true) }
          : preview,
      );
    }
    for (const binding of model.bindings)
      binding.configuration = this.clean(binding.configuration, secrets, true);
    const redacted = redactStructureStrings(model, secrets);
    if (
      Buffer.byteLength(JSON.stringify(redacted), 'utf8') >
      policyStructureLimits.bytes
    )
      return unavailablePolicyStructure(
        redacted.source.experimentId,
        'oversized',
        'The redacted structure exceeds the 4 MiB visualization limit.',
        redacted.source,
      );
    return redacted;
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
    visit(await this.experiment(id));
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
    ] as const)
      for await (const entry of this.scanOwned(kind, id)) {
        if (kind === 'revisions') {
          if (entry.resourceRef) collect(entry.resourceRef);
        } else if (kind === 'candidates') collect(entry.artifactRef!);
        else if (kind === 'calls') {
          if (entry.output !== undefined) collect(entry.output);
          if (
            entry.pluginId === 'memory.agent' &&
            entry.input &&
            typeof entry.input === 'object' &&
            !Array.isArray(entry.input) &&
            entry.input.memoryRef
          )
            collect(entry.input.memoryRef);
          if (entry.evidenceRef !== undefined) collect(entry.evidenceRef);
        } else collect(entry);
      }
    return refs;
  }

  /** Compact learning records; file contents use the existing bounded artifact projection. */
  private async reflectionPaths(id: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    for await (const record of this.scanOwned('reflection', id)) {
      if (
        typeof record.reflectionId === 'string' &&
        typeof record.stepPath === 'string'
      )
        paths.set(record.reflectionId, record.stepPath);
    }
    return paths;
  }

  async learning(
    id: string,
    kind: 'revisions' | 'memories',
  ): Promise<JsonObject[]> {
    const secrets = await this.secrets(id);
    const paths =
      kind === 'revisions'
        ? await this.reflectionPaths(id)
        : new Map<string, string>();
    const records: JsonObject[] = [];
    for await (const entry of this.scanOwned(
      kind === 'revisions' ? 'revisions' : 'calls',
      id,
    )) {
      if (kind === 'revisions') {
        records.push({
          id: entry.ref ?? null,
          path: paths.get(String(entry.reflectionId)) ?? null,
          binding: entry.binding ?? null,
          kind: entry.kind ?? 'legacy',
          parentRef: entry.parentRef ?? null,
          resourceRef: entry.resourceRef ?? null,
          reason: entry.reason ?? null,
          status: entry.status ?? 'unknown',
        });
      } else if (entry.pluginId === 'memory.agent') {
        const input =
          entry.input &&
          typeof entry.input === 'object' &&
          !Array.isArray(entry.input)
            ? entry.input
            : {};
        const output =
          entry.output &&
          typeof entry.output === 'object' &&
          !Array.isArray(entry.output)
            ? entry.output
            : {};
        records.push({
          id: entry.callId ?? null,
          binding: entry.bindingId ?? null,
          kind: 'memory',
          parentRef: input.memoryRef ?? null,
          resourceRef: output.memoryRef ?? null,
          reason: output.reason ?? entry.error ?? null,
          status: output.status ?? entry.status ?? 'unknown',
          path: entry.path ?? null,
          startedAt: entry.startedAt ?? null,
        });
      }
    }
    return records.map((record) => object(this.clean(record, secrets)));
  }

  async assertRevision(id: string, ref: string): Promise<void> {
    await this.experiment(id);
    const revision = await this.facts.read('revisions', safeId(ref));
    if (revision.experimentId !== id)
      throw Object.assign(new Error('Revision not found in experiment'), {
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
    if (record.output !== undefined && result && !result.truncated)
      recordedStrings(record.output, '', (ref, path) => {
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

  private summary(record: JsonObject, secrets: string[]): ExperimentSummary {
    return {
      id: string(record.id),
      recipeId: optionalText(record.recipeId),
      status: string(record.status),
      startedAt: optionalText(record.startedAt),
      finishedAt: optionalText(record.finishedAt),
      error:
        typeof record.error === 'string'
          ? redactText(record.error, secrets)
          : null,
    };
  }
  async experiments(offset = 0, limit = 50): Promise<Page<ExperimentSummary>> {
    const entries = await this.facts.list('experiments');
    entries.sort(
      (a, b) =>
        String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) ||
        string(a.id).localeCompare(string(b.id)),
    );
    const selected = page(entries, offset, limit);
    return {
      ...selected,
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
      ...this.summary(record, secrets),
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
          'pluginId',
          'path',
          'status',
          'startedAt',
          'finishedAt',
          'error',
        ])
          if (entry[key] !== undefined) compact[key] = entry[key];
        const output = entry.output;
        if (output && typeof output === 'object' && !Array.isArray(output)) {
          compact.output = {};
          for (const key of ['candidateRef', 'initialCandidateRef'])
            if (typeof output[key] === 'string')
              compact.output[key] = output[key];
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
      path: optionalText(record.path),
      triggerPath:
        record.pluginId === 'reflection.agent'
          ? (paths.get(String(record.path).replace(/^reflection\//, '')) ??
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
    const paths = await this.reflectionPaths(id);
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
  async callTrace(
    id: string,
    callId: string,
    offset = 0,
    limit = 50,
  ): Promise<CallTrace> {
    const call = await this.ownedCall(id, callId);
    page([], offset, limit);
    const empty = (unavailable: string): CallTrace => ({
      ...page([], offset, limit),
      unavailable,
      incomplete: false,
    });
    if (call.pluginId !== 'agent.pi' || !this.directory)
      return empty('No supported agent trace is available for this call.');
    let file;
    try {
      file = await open(
        join(
          this.directory,
          'experiments',
          safeId(id),
          'calls',
          safeId(callId),
          'diagnostics.jsonl',
        ),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (missing(error))
        return empty('No trace has been recorded for this call.');
      throw error;
    }
    try {
      const secrets = this.payloadSecrets(
        call.output ?? null,
        this.payloadSecrets(call.input ?? null, await this.secrets(id)),
      );
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const raw = buffer.subarray(0, bytesRead).toString('utf8');
      const complete = raw.slice(0, raw.lastIndexOf('\n') + 1);
      let incomplete = bytesRead < size || complete.length !== raw.length;
      const items: CallTrace['items'] = [];
      for (const [sequence, line] of complete.split('\n').entries()) {
        if (!line) continue;
        try {
          const event: unknown = JSON.parse(line);
          if (
            !event ||
            typeof event !== 'object' ||
            !('type' in event) ||
            typeof event.type !== 'string' ||
            !('data' in event)
          ) {
            incomplete = true;
            continue;
          }
          // Match serialized values so replacement cannot split a JSON escape.
          const content = redactText(
            JSON.stringify(event.data, null, 2),
            secrets.map((secret) => JSON.stringify(secret).slice(1, -1)),
          );
          items.push({
            sequence,
            at: 'at' in event && typeof event.at === 'string' ? event.at : null,
            type: event.type,
            content: {
              text: content.slice(0, 32768),
              truncated: content.length > 32768,
            },
          });
        } catch {
          incomplete = true;
        }
      }
      return { ...page(items, offset, limit), unavailable: null, incomplete };
    } finally {
      await file.close();
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
  ): Promise<CallInstructions> {
    const record = await this.ownedCall(id, callId);
    const input = record.input;
    const prompt =
      input && typeof input === 'object' && !Array.isArray(input)
        ? input.prompt
        : null;
    if (typeof prompt !== 'string') return { prompt: null };
    const secrets = this.payloadSecrets(record.input!, await this.secrets(id));
    const text = redactText(prompt, secrets);
    return {
      prompt: { text: text.slice(0, 32768), truncated: text.length > 32768 },
    };
  }
  async callDetail(id: string, callId: string): Promise<CallDetail> {
    const secrets = await this.secrets(id),
      record = await this.ownedCall(id, callId);
    return {
      ...this.call(record, secrets, await this.reflectionPaths(id)),
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
    const originsByRef = new Map<string, JsonObject[]>();
    calls.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.callId).localeCompare(string(b.callId)),
    );
    for (const call of calls) {
      const output = call.output;
      if (!output || typeof output !== 'object' || Array.isArray(output))
        continue;
      for (const ref of new Set([
        output.candidateRef,
        output.initialCandidateRef,
      ])) {
        if (typeof ref !== 'string') continue;
        const origins = originsByRef.get(ref) ?? [];
        origins.push(call);
        originsByRef.set(ref, origins);
      }
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
    const originPath = (ref: string): string | null => {
      for (const origin of originsByRef.get(ref) ?? []) {
        const path = callPath(origin);
        if (path) return path;
      }
      return null;
    };

    entries.sort((a, b) => string(a.ref).localeCompare(string(b.ref)));
    const selected = page(entries, offset, limit);
    return {
      ...selected,
      items: selected.items.map((entry) => ({
        ref: string(entry.ref),
        parentRef: optionalText(entry.parentRef),
        artifactRef: string(entry.artifactRef),
        originPath: originPath(string(entry.ref)),
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
