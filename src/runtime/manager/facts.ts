import type {
  ArtifactStore,
  FactStore,
  Candidate,
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../contracts/index.js';
import { digest, object, string, strings } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import {
  validateMeasurement,
  measurementItemsSchema,
  measurementEvidenceSchema,
  metricDefinitionSchema,
  type Measurement,
} from '../../contracts/models/measurement.js';
import type { Registry } from '../registry/index.js';
import { projectEvidence } from '../services/facts/evidence.js';
import { projectEvidenceFiles } from '../services/facts/evidence-files.js';

/** Owns candidate and measurement facts and authorizes their evidence views. */
export class ExperimentFacts {
  constructor(
    private readonly id: string,
    private readonly facts: FactStore,
    private readonly artifacts: ArtifactStore,
    private readonly registry: Registry,
    private readonly plugin: (bindingId: string) => string | undefined,
  ) {}

  async readCandidate(ref: string, ctx: RuntimeContext): Promise<Candidate> {
    const candidate = await this.facts.read('candidates', ref);
    if (candidate.experimentId !== ctx.experimentId)
      throw new Error('Candidate belongs to another experiment');
    return {
      ref,
      artifactRef: string(candidate.artifactRef),
      parentRef:
        candidate.parentRef === null ? null : string(candidate.parentRef),
      experimentId: this.id,
    };
  }

  async recordCandidate(
    artifactRef: string,
    parentRef: string | null,
    ctx: RuntimeContext,
  ): Promise<string> {
    if (parentRef) await this.readCandidate(parentRef, ctx);
    const ref =
      'candidate-' +
      digest({ id: this.id, artifactRef, parentRef }).slice(0, 32);
    await this.facts.write('candidates', ref, {
      ref,
      artifactRef,
      parentRef,
      experimentId: this.id,
    });
    return ref;
  }

  async readMeasurement(
    ref: string,
    ctx: RuntimeContext,
  ): Promise<Measurement> {
    const measurement = await this.facts.read('measurements', ref);
    if (measurement.experimentId !== ctx.experimentId)
      throw new Error('Measurement belongs to another experiment');
    validateMeasurement(measurement);
    return measurement;
  }

  async recordMeasurement(
    input: JsonObject,
    ctx: RuntimeContext,
  ): Promise<string> {
    const measurement = structuredClone(input);
    if (
      measurement.experimentId !== this.id ||
      measurement.callId !== ctx.callId
    )
      throw new Error('Invalid measurement ownership');
    const evaluator = object(measurement.evaluator);
    const pluginId = this.plugin(ctx.bindingId) ?? string(evaluator.pluginId);
    measurement.evaluator = {
      ...evaluator,
      pluginId,
      implementationDigest: digest({
        adapter: evaluator.implementationDigest,
        registration: this.registry.identity(pluginId),
      }),
    };
    const { ref: _priorRef, ...content } = measurement;
    const ref = 'measurement-' + digest(content);
    measurement.ref = ref;
    validateMeasurement(measurement);
    await this.validateArtifacts(measurement);
    let prior: JsonObject | undefined;
    try {
      prior = await this.facts.read('measurements', ref);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    if (prior && digest(prior) !== digest(measurement))
      throw new Error('Immutable Measurement cannot be overwritten');
    if (!prior) await this.facts.write('measurements', ref, measurement);
    return ref;
  }

  async readEvidence(
    refs: string[],
    options: Parameters<RuntimeContext['readEvidence']>[1],
    ctx: RuntimeContext,
  ): Promise<JsonValue> {
    const requestedBytes = options?.maxBytes;
    if (
      requestedBytes !== undefined &&
      (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0)
    )
      throw new Error('readEvidence.maxBytes must be a positive safe integer');
    const fileMode = options?.format === 'files';
    const maxBytes = Math.min(
      requestedBytes ?? (fileMode ? 32 * 1024 * 1024 : 60000),
      fileMode ? 32 * 1024 * 1024 : 80000,
      ctx.scope?.limits.evidenceBytes ?? Number.POSITIVE_INFINITY,
    );
    const view = options?.view ?? 'execution';
    const measurements: JsonObject[] = [];
    const summaries: JsonValue[] = [];
    for (const ref of refs) {
      if (ref.startsWith('artifact:'))
        throw new Error(
          'Evidence requires an authorized reference, not an artifact',
        );
      const references = ref.startsWith('evidence-')
        ? await this.facts.read('evidence-views', ref)
        : null;
      if (references && references.experimentId !== this.id)
        throw new Error('Evidence belongs to another experiment');
      if (references?.summary) summaries.push(references.summary);
      for (const measurementRef of references
        ? strings(references.measurementRefs)
        : [ref]) {
        const m = await this.readMeasurement(measurementRef, ctx);
        measurements.push(m);
      }
    }
    if (fileMode) {
      const result = await projectEvidenceFiles({
        measurements,
        artifacts: this.artifacts,
        view,
        maxBytes,
      });
      if (summaries.length) result.summaries = summaries;
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
        throw new Error('Full evidence context exceeds byte limit');
      return result;
    }
    const result = await projectEvidence({
      measurements,
      artifacts: this.artifacts,
      view,
      maxBytes: summaries.length
        ? Math.max(256, Math.floor(maxBytes * 0.7))
        : maxBytes,
    });
    const output = object(result);
    if (summaries.length) {
      const accepted: JsonValue[] = [];
      for (const summary of summaries) {
        if (
          Buffer.byteLength(
            JSON.stringify({ ...output, context: [...accepted, summary] }),
          ) > maxBytes
        ) {
          output.truncated = true;
          break;
        }
        accepted.push(summary);
      }
      output.context = accepted;
    }
    if (Buffer.byteLength(JSON.stringify(output)) > maxBytes)
      throw new Error('Evidence context exceeds byte limit');
    return output;
  }

  private async validateArtifacts(measurement: Measurement): Promise<void> {
    const checked = new Set<string>();
    const checkTypedArtifact = async (value: JsonValue): Promise<void> => {
      const descriptor = object(value);
      await this.artifacts.readJson(string(descriptor.artifactRef));
    };
    const metrics = async (value: JsonValue): Promise<void> => {
      for (const raw of Object.values(object(value))) {
        const observation = object(raw),
          ref = string(observation.definitionRef);
        if (!checked.has(ref)) {
          validate(
            metricDefinitionSchema,
            await this.artifacts.readJson(ref),
            'metric definition',
          );
          checked.add(ref);
        }
      }
    };
    for (const field of ['conditions', 'provenance', 'profile'])
      await checkTypedArtifact(measurement[field]!);
    if (Array.isArray(measurement.extensions))
      for (const value of measurement.extensions)
        await checkTypedArtifact(value);
    const items = await this.artifacts.readJson(string(measurement.itemsRef));
    validate(measurementItemsSchema, items, 'Measurement items');
    const entries = object(items).items;
    if (!Array.isArray(entries)) throw new Error('Measurement items missing');
    for (const raw of entries) {
      const item = object(raw);
      await checkTypedArtifact(item.details!);
      if (item.evaluation !== null) await checkTypedArtifact(item.evaluation!);
      const subject = object(item.subject);
      if (subject.parameters !== null)
        await checkTypedArtifact(subject.parameters!);
      await metrics(item.metrics!);
      validate(
        measurementEvidenceSchema,
        await this.artifacts.readJson(string(item.evidenceIndexRef)),
        'Item evidence',
      );
    }
    await metrics(measurement.metrics!);
    validate(
      measurementEvidenceSchema,
      await this.artifacts.readJson(string(measurement.evidenceIndexRef)),
      'Measurement evidence',
    );
  }
}
