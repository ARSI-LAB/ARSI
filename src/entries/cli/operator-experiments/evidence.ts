import { createHash } from 'node:crypto';
import {
  parseKernelAssessment,
  parseKernelContract,
  parseKernelTimingEvidence,
  auditKernelTimingSample,
} from 'ember-evaluator';
import type { Manager } from '../../../runtime/manager/index.js';
import { parseFileTree } from '../../../contracts/models/file-tree.js';
import { validateMeasurement } from '../../../contracts/models/measurement.js';
import { digest, object, string } from '../../../shared/json.js';
import type { JsonObject } from '../../../contracts/index.js';
import type { CalibrationMeasurement } from './statistics.js';

export type EvidenceReader = Pick<Manager, 'facts' | 'artifacts' | 'get'>;
export type ExperimentEvidence = {
  id: string;
  measurements: CalibrationMeasurement[];
  fixture: boolean;
  sourceUnchanged: boolean;
  finishedAt: string;
  usage: JsonObject;
  profilingReady: boolean;
};
function scalar(measurement: JsonObject, name: string): number {
  const metric = object(object(measurement.metrics)[name]);
  const value = object(metric.value);
  if (
    metric.status !== 'available' ||
    value.kind !== 'scalar' ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value) ||
    value.value <= 0
  )
    throw new Error(`Unavailable calibration metric ${name}`);
  return value.value;
}
export async function readExperimentEvidence(
  manager: EvidenceReader,
  id: string,
): Promise<ExperimentEvidence> {
  const experiment = await manager.get(id);
  if (experiment.status !== 'succeeded')
    throw new Error(`Experiment ${id} is not succeeded`);
  const usage = object(experiment.usage);
  if (usage.evaluationRuns !== 2 || (usage.modelCalls ?? 0) !== 0)
    throw new Error(
      'Calibration requires two evaluations and zero model calls',
    );
  const calls = (await manager.facts.list('calls')).filter(
    (c) => c.experimentId === id,
  );
  if (
    calls.some(
      (c) =>
        c.status !== 'succeeded' ||
        c.bindingId === 'agent' ||
        c.bindingId === 'proposer',
    )
  )
    throw new Error('Failed, unknown or proposing calibration call');
  if (
    (await manager.facts.list('instances')).some(
      (i) => i.experimentId === id && i.status !== 'released',
    )
  )
    throw new Error('Unreleased calibration instance');
  const output = object(experiment.output);
  if (
    !Array.isArray(output.attempts) ||
    output.attempts.length ||
    output.finalValidity !== 'valid'
  )
    throw new Error('Invalid baseline-only output');
  const refs = [
    string(output.bestMeasurementRef),
    string(output.finalMeasurementRef),
  ];
  const all = (await manager.facts.list('measurements')).filter(
    (m) => m.experimentId === id,
  );
  if (all.length !== 2 || refs[0] === refs[1])
    throw new Error('Expected two distinct measurements');
  const initial = string(object(experiment.application).initialCandidateRef);
  if (output.bestCandidateRef !== initial)
    throw new Error('Baseline source changed');
  const initialFact = await manager.facts.read('candidates', initial);
  const sourceTree = parseFileTree(
    await manager.artifacts.readJson(string(initialFact.artifactRef)),
  );
  const source = sourceTree.files.find((f) => f.path === 'input.py');
  if (!source) throw new Error('Missing baseline source');
  const sourceDigest = createHash('sha256')
    .update(Buffer.from(source.base64, 'base64'))
    .digest('hex');
  const measurements: CalibrationMeasurement[] = [];
  let finishedAt = '',
    profilingReady = true;
  for (const ref of refs) {
    const measurement = all.find((m) => m.ref === ref);
    if (!measurement) throw new Error('Measurement ownership mismatch');
    validateMeasurement(measurement);
    if (
      measurement.status !== 'succeeded' ||
      measurement.coverage !== 'complete' ||
      measurement.candidateRef !== initial ||
      scalar(measurement, 'candidateValid') !== 1
    )
      throw new Error('Incomplete or invalid calibration measurement');
    const conditions = object(
      await manager.artifacts.readJson(
        string(object(measurement.conditions).artifactRef),
      ),
    );
    if (measurement.comparisonKey !== digest(conditions))
      throw new Error('Calibration comparison identity mismatch');
    const provenance = object(
      await manager.artifacts.readJson(
        string(object(measurement.provenance).artifactRef),
      ),
    );
    if (
      provenance.sourceDigest !== sourceDigest ||
      provenance.cleanup !== 'confirmed'
    )
      throw new Error('Calibration source or cleanup unconfirmed');
    const native = object(
      await manager.artifacts.readJson(string(measurement.diagnosticsRef)),
    );
    const snapshot = object(native.snapshot);
    if (
      !Array.isArray(snapshot.records) ||
      snapshot.records.length !== 1 ||
      native.exitCode !== 0 ||
      object(snapshot.run).status !== 'completed'
    )
      throw new Error('Incomplete native SDK result');
    const record = object(snapshot.records[0]);
    if (
      record.cleanupStatus !== 'cleaned' ||
      record.executionStatus !== 'completed' ||
      record.scoreStatus !== 'valid'
    )
      throw new Error('Native execution or cleanup incomplete');
    const verdict = object(record.verdict),
      details = object(verdict.details);
    if (
      verdict.passed !== true ||
      details.candidateSha256 !== sourceDigest ||
      native.runId !== provenance.runId
    )
      throw new Error('Native source or run identity mismatch');
    const evaluation = object(conditions.evaluation);
    const contract = parseKernelContract(evaluation.contract);
    const assessment = parseKernelAssessment(details.assessment, contract, [
      42,
    ]);
    if (
      assessment.errorOwnership !== null ||
      assessment.checks.some((c) => c.status !== 'passed') ||
      Object.values(assessment.environment).some((v) => !v)
    )
      throw new Error('Strict assessment incomplete');
    if (
      digest(assessment.environment) !== digest(evaluation.environment) ||
      digest(assessment.effectiveProtocol) !== digest(evaluation.protocol)
    )
      throw new Error('Observed evaluation conditions mismatch');
    const timing = parseKernelTimingEvidence(details.timingEvidence);
    const { warmup, repeat, rtol, atol } = assessment.effectiveProtocol;
    if (
      rtol !== 0 ||
      atol !== 0 ||
      timing.reference.warmup !== warmup ||
      timing.reference.repeat !== repeat
    )
      throw new Error('Timing protocol mismatch');
    const index = object(
      await manager.artifacts.readJson(string(measurement.evidenceIndexRef)),
    );
    if (!Array.isArray(index.entries))
      throw new Error('Missing archived evidence');
    const verifier = index.entries
      .map((e) => object(e))
      .find(
        (e) => e.kind === 'verifier' && e.attemptId === provenance.attemptId,
      );
    if (!verifier) throw new Error('Missing verifier file tree');
    const tree = parseFileTree(
      await manager.artifacts.readJson(string(verifier.artifactRef)),
    );
    const rawFile = tree.files.find((f) => f.path === 'kernel-result.json');
    if (!rawFile) throw new Error('Missing native kernel file');
    const raw = object(
      JSON.parse(Buffer.from(rawFile.base64, 'base64').toString('utf8')),
    );
    if (
      digest(raw.timingEvidence) !== digest(details.timingEvidence) ||
      digest(raw.assessment) !== digest(details.assessment)
    )
      throw new Error('Archived kernel evidence mismatch');
    for (const sample of [timing.reference, timing.candidate]) {
      const file = tree.files.find((f) => f.path === sample.csvPath);
      if (!file) throw new Error('Missing archived timing CSV');
      const trace = tree.files.find((f) => f.path === sample.tracePath);
      if (!trace) throw new Error('Missing archived timing trace');
      auditKernelTimingSample(
        sample,
        Buffer.from(file.base64, 'base64'),
        Buffer.from(trace.base64, 'base64'),
      );
    }
    const candidateMs = scalar(measurement, 'latencyMeanMs'),
      referenceMs = scalar(measurement, 'referenceMeanMs');
    if (
      Math.abs(candidateMs - timing.candidate.meanMs) > 1e-12 ||
      Math.abs(referenceMs - timing.reference.meanMs) > 1e-12 ||
      raw.candidateMs !== candidateMs ||
      raw.referenceMs !== referenceMs
    )
      throw new Error('Measurement does not match timing evidence');
    const profile =
      details.profiling === undefined ? null : object(details.profiling);
    const metadata =
      profile?.metadata === undefined ? {} : object(profile.metadata);
    const candidate =
      metadata.sources === undefined
        ? {}
        : object(object(metadata.sources).candidate);
    profilingReady &&=
      profile?.status === 'completed' &&
      Array.isArray(profile.kernels) &&
      profile.kernels.length > 0 &&
      candidate.sha256 === sourceDigest &&
      metadata.cacheHit === false &&
      typeof metadata.collection === 'string' &&
      typeof metadata.upstreamCommit === 'string' &&
      typeof metadata.roundNum === 'number' &&
      Array.isArray(profile.artifacts) &&
      profile.artifacts.length > 0 &&
      profile.artifacts.every(
        (path) =>
          typeof path === 'string' && tree.files.some((f) => f.path === path),
      ) &&
      profile.kernels.every(
        (k) => Object.keys(object(object(k).metrics)).length > 0,
      );
    finishedAt = string(measurement.finishedAt);
    measurements.push({
      measurementRef: ref,
      experimentId: id,
      runId: string(native.runId),
      comparisonKey: string(measurement.comparisonKey),
      sourceDigest,
      batch: 0,
      candidateMs,
      referenceMs,
      warmup,
      repeat,
      fixture: Object.values(assessment.environment).some((v) =>
        v?.includes('TEST-FIXTURE'),
      ),
    });
  }
  if (
    measurements[0].comparisonKey !== measurements[1].comparisonKey ||
    measurements[0].runId === measurements[1].runId
  )
    throw new Error(
      'Independent baseline measurements differ in conditions or repeat a run',
    );
  return {
    id,
    measurements,
    fixture: measurements.some((m) => m.fixture),
    sourceUnchanged: true,
    finishedAt,
    usage,
    profilingReady,
  };
}
