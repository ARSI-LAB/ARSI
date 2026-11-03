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
import { safeId } from '../storage/index.js';

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

/** Reads through existing stores; never writes facts, executes plugins, or interprets Policy outputs. */
export class ObservationQueries {
  constructor(
    private readonly facts: Pick<FactStore, 'read' | 'list'>,
    private readonly artifacts: Pick<ArtifactStore, 'readJson'>,
  ) {}

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
  private clean(value: JsonValue, secrets: string[]): JsonValue {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value))
      return value.map((item) => this.clean(item, secrets));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretField.test(key) ? '[REDACTED]' : this.clean(item, secrets),
        ]),
      );
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
    for (const kind of ['candidates', 'measurements', 'calls'] as const)
      for (const entry of await this.owned(kind, id)) {
        if (kind === 'candidates') collect(entry.artifactRef!);
        else if (kind === 'calls') {
          if (entry.output !== undefined) collect(entry.output);
          if (entry.evidenceRef !== undefined) collect(entry.evidenceRef);
        } else collect(entry);
      }
    return refs;
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
    if (!(await this.artifactRefs(id)).has(ref))
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
      if (
        /(^|\/)(\.env(?:\..*)?|[^/]*(?:credential|secret|token|password|private[-_]?key)[^/]*|id_rsa|id_ed25519)$/i.test(
          path,
        )
      )
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
      text = redactText(text, secrets)
        .replace(
          /((?:api[-_]?key|token|secret|password|authorization|credential)["']?\s*[:=]\s*)[^\r\n]+/gi,
          '$1[REDACTED]',
        )
        .replace(
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
  private async owned(kind: string, id: string): Promise<JsonObject[]> {
    await this.experiment(id);
    return (await this.facts.list(kind)).filter(
      (entry) => entry.experimentId === id,
    );
  }
  private call(record: JsonObject, secrets: string[]): CallSummary {
    return {
      callId: string(record.callId),
      parentCallId: optionalText(record.parentCallId),
      bindingId: string(record.bindingId),
      pluginId: string(record.pluginId),
      path: optionalText(record.path),
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
    const entries = await this.owned('calls', id),
      secrets = await this.secrets(id);
    entries.sort(
      (a, b) =>
        String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
        string(a.callId).localeCompare(string(b.callId)),
    );
    return page(
      entries.map((entry) => this.call(entry, secrets)),
      offset,
      limit,
    );
  }
  async callDetail(id: string, callId: string): Promise<CallDetail> {
    const secrets = await this.secrets(id),
      record = await this.facts.read('calls', safeId(callId));
    if (record.experimentId !== id)
      throw Object.assign(new Error('Call not found in experiment'), {
        statusCode: 404,
      });
    return {
      ...this.call(record, secrets),
      input: this.preview(record.input, secrets),
      output: this.preview(record.output, secrets),
    };
  }
  async candidates(
    id: string,
    offset = 0,
    limit = 50,
  ): Promise<Page<CandidateSummary>> {
    const entries = await this.owned('candidates', id);
    entries.sort((a, b) => string(a.ref).localeCompare(string(b.ref)));
    return page(
      entries.map((entry) => ({
        ref: string(entry.ref),
        parentRef: optionalText(entry.parentRef),
        artifactRef: string(entry.artifactRef),
      })),
      offset,
      limit,
    );
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
