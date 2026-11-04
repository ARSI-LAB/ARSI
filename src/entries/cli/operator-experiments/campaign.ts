import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Manager } from '../../../runtime/manager/index.js';
import type { JsonObject } from '../../../contracts/index.js';
import { object, string, digest } from '../../../shared/json.js';
import { readExperimentEvidence, type ExperimentEvidence } from './evidence.js';
import {
  summarizeCalibration,
  type CalibrationMeasurement,
  type CalibrationStatistics,
} from './statistics.js';
import { acquireDeviceSession } from './device-session.js';

type Stage = 'initial' | 'batch-1' | 'batch-2' | 'profiling';
type Entry = { id: string; stage: Stage };
export type Campaign = {
  schemaVersion: 1;
  id: string;
  hostIdentity: string;
  inputIdentity: string;
  preflight: JsonObject;
  warmup: number;
  repeat: number;
  intervalMs: number;
  entries: Entry[];
  adjustment: { parentId: string; diagnosis: string } | null;
};
export type ExperimentSnapshot = { recipePath: string; identity: string };
type Operations = {
  rootDirectory: string;
  id: string;
  manager: Manager;
  prepare: (
    entry: Entry,
    campaign: Campaign,
    resume: boolean,
  ) => Promise<ExperimentSnapshot>;
};
export type CampaignReport = {
  id: string;
  basicLoop: string;
  performance: string;
  profiling: string;
  recovery: string;
  measurements: CalibrationMeasurement[];
  experiments: ExperimentEvidence[];
  statistics: CalibrationStatistics | null;
  evaluationRuns: number;
  modelCalls: number;
  errors: { id: string; status: string; error: string }[];
  reportPath: string;
};
function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
    throw new Error('Unsafe campaign identifier');
  return value;
}
function directory(root: string, id: string): string {
  return join(root, '.rsi/operator-calibration', safeId(id));
}
async function readJson(path: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, 'utf8')));
}
async function save(
  path: string,
  value: unknown,
  exclusive = false,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify(value, null, 2) + '\n',
    exclusive ? { flag: 'wx' } : {},
  );
}
function entriesFor(
  id: string,
  adjusted: boolean,
  profiling: boolean,
): Entry[] {
  const entries: Entry[] = adjusted
    ? []
    : [{ id: `${id}-initial`, stage: 'initial' }];
  for (const batch of [1, 2] as const)
    for (let pair = 1; pair <= 5; pair++)
      entries.push({
        id: `${id}-b${batch}-p${pair}`,
        stage: batch === 1 ? 'batch-1' : 'batch-2',
      });
  if (profiling) entries.push({ id: `${id}-profiling`, stage: 'profiling' });
  return entries;
}
async function loadCampaign(root: string, id: string): Promise<Campaign> {
  const raw = await readJson(join(directory(root, id), 'manifest.json'));
  const adjustment =
    raw.adjustment === null
      ? null
      : {
          parentId: safeId(string(object(raw.adjustment).parentId)),
          diagnosis: string(object(raw.adjustment).diagnosis),
        };
  const adjusted = adjustment !== null;
  if (
    raw.schemaVersion !== 1 ||
    raw.id !== id ||
    raw.warmup !== (adjusted ? 10 : 5) ||
    raw.repeat !== (adjusted ? 100 : 20) ||
    raw.intervalMs !== 600000 ||
    !Array.isArray(raw.entries)
  )
    throw new Error('Invalid calibration manifest');
  const entries = entriesFor(
    id,
    adjusted,
    raw.entries.some((e) => object(e).stage === 'profiling'),
  );
  if (digest(raw.entries) !== digest(entries))
    throw new Error('Calibration manifest stages changed');
  return {
    schemaVersion: 1,
    id,
    hostIdentity: string(raw.hostIdentity),
    inputIdentity: string(raw.inputIdentity),
    preflight: object(raw.preflight),
    warmup: adjusted ? 10 : 5,
    repeat: adjusted ? 100 : 20,
    intervalMs: 600000,
    entries,
    adjustment,
  };
}
export async function initializeCampaign(options: {
  rootDirectory: string;
  id: string;
  hostIdentity: string;
  inputIdentity: string;
  profiling: boolean;
  preflight: JsonObject;
  adjustment?: { parentId: string; diagnosis: string };
}): Promise<Campaign> {
  const { rootDirectory: root, id } = options;
  safeId(id);
  if (options.preflight.ready !== true)
    throw new Error('NPU preflight is not ready');
  const adjusted = options.adjustment !== undefined;
  if (adjusted) {
    if (!options.adjustment!.diagnosis.trim())
      throw new Error('Protocol adjustment requires evidence-backed diagnosis');
    const parent = await loadCampaign(root, options.adjustment!.parentId);
    const report = await readJson(
      join(directory(root, parent.id), 'report.json'),
    );
    if (
      parent.adjustment ||
      parent.hostIdentity !== options.hostIdentity ||
      parent.inputIdentity !== options.inputIdentity ||
      report.performance !== 'failed-noise' ||
      report.basicLoop !== 'passed' ||
      report.recovery !== 'verified' ||
      !Array.isArray(report.errors) ||
      report.errors.length
    )
      throw new Error(
        'Adjustment requires a completed device calibration failing only noise with unchanged inputs/environment',
      );
    // A durable reservation intentionally survives a crash; never silently spend another adjustment budget.
    await save(
      join(directory(root, parent.id), 'adjustment.json'),
      { childId: id, diagnosis: options.adjustment!.diagnosis },
      true,
    );
  }
  const manifest: Campaign = {
    schemaVersion: 1,
    id,
    hostIdentity: options.hostIdentity,
    inputIdentity: options.inputIdentity,
    preflight: options.preflight,
    warmup: adjusted ? 10 : 5,
    repeat: adjusted ? 100 : 20,
    intervalMs: 600000,
    entries: entriesFor(id, adjusted, options.profiling),
    adjustment: options.adjustment ?? null,
  };
  const path = directory(root, id);
  await mkdir(join(root, '.rsi/operator-calibration'), { recursive: true });
  await mkdir(path);
  await save(join(path, 'manifest.json'), manifest, true);
  return manifest;
}
async function receiptIdentity(manager: Manager, id: string): Promise<string> {
  const experiment = await manager.get(id);
  return digest({
    usage: experiment.usage,
    output: experiment.output,
    calls: (await manager.facts.list('calls')).filter(
      (c) => c.experimentId === id,
    ),
    measurements: (await manager.facts.list('measurements')).filter(
      (m) => m.experimentId === id,
    ),
  });
}
async function verifySnapshot(
  options: Operations,
  manifest: Campaign,
  entry: Entry,
  resume: boolean,
): Promise<ExperimentSnapshot> {
  const snapshot = await options.prepare(entry, manifest, resume);
  if (snapshot.identity !== manifest.inputIdentity)
    throw new Error(
      'Campaign input/build identity changed; start a new campaign',
    );
  return snapshot;
}
export async function runCampaign(
  options: Operations & {
    resume?: boolean;
    signal?: AbortSignal;
    observe: () => Promise<{ ready: boolean; identity: string }>;
    clock?: {
      now: () => number;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    };
    onProgress?: (message: string) => void;
  },
): Promise<CampaignReport> {
  const manifest = await loadCampaign(options.rootDirectory, options.id);
  const base = directory(options.rootDirectory, options.id);
  const lease = await acquireDeviceSession({
    rootDirectory: options.rootDirectory,
    owner: `campaign:${options.id}`,
    reader: options.manager,
  });
  const clock = options.clock ?? {
    now: Date.now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      await delay(ms, undefined, { signal });
    },
  };
  try {
    const observe = async (): Promise<void> => {
      options.signal?.throwIfAborted();
      const current = await options.observe();
      if (!current.ready || current.identity !== manifest.hostIdentity)
        throw new Error('Campaign environment changed or is not ready');
    };
    await observe();
    const existing = await options.manager.facts.list('experiments');
    if (
      !options.resume &&
      manifest.entries.some((e) => existing.some((f) => f.id === e.id))
    )
      throw new Error('Campaign has existing experiments; use --resume');
    // Refuse all unfinished facts before launching any additional device work.
    for (const entry of manifest.entries) {
      const fact = existing.find((f) => f.id === entry.id);
      if (fact && fact.status !== 'succeeded')
        throw new Error(
          `Experiment ${entry.id} unfinished, failed or unknown; no automatic retry`,
        );
    }
    let identity: string | undefined;
    let firstEvidence: ExperimentEvidence | undefined;
    for (const entry of manifest.entries) {
      options.signal?.throwIfAborted();
      options.onProgress?.(`${entry.id}: checking recorded facts and inputs`);
      const fact = (await options.manager.facts.list('experiments')).find(
        (f) => f.id === entry.id,
      );
      const snapshot = await verifySnapshot(
        options,
        manifest,
        entry,
        Boolean(fact),
      );
      if (!fact) {
        if (entry.stage === 'batch-2' && entry.id.endsWith('-p1')) {
          const last = await readExperimentEvidence(
            options.manager,
            `${manifest.id}-b1-p5`,
          );
          const deadline = Date.parse(last.finishedAt) + manifest.intervalMs;
          if (!Number.isFinite(deadline))
            throw new Error('Invalid batch completion time');
          while (clock.now() < deadline) {
            options.onProgress?.(
              `Batch interval: ${Math.ceil((deadline - clock.now()) / 1000)} seconds remaining`,
            );
            await clock.sleep(
              Math.min(30000, deadline - clock.now()),
              options.signal,
            );
            options.signal?.throwIfAborted();
          }
          const gapPath = join(base, 'batch-gap.json');
          try {
            const saved = await readJson(gapPath);
            if (
              saved.previousId !== last.id ||
              saved.previousFinishedAt !== last.finishedAt ||
              saved.nextId !== entry.id ||
              saved.notBefore !== deadline ||
              typeof saved.observedAt !== 'number' ||
              saved.observedAt < deadline
            )
              throw new Error('Batch interval proof changed');
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              throw error;
            await save(
              gapPath,
              {
                previousId: last.id,
                previousFinishedAt: last.finishedAt,
                nextId: entry.id,
                notBefore: deadline,
                observedAt: clock.now(),
              },
              true,
            );
          }
        }
        await observe();
        options.onProgress?.(`${entry.id}: starting two SDK evaluations`);
        await options.manager.run(snapshot.recipePath, {
          id: entry.id,
          signal: options.signal,
        });
      }
      const evidence = await readExperimentEvidence(options.manager, entry.id);
      options.onProgress?.(`${entry.id}: timing evidence and cleanup verified`);
      const current = evidence.measurements[0].comparisonKey;
      // Profiling has a different request identity; it never enters formal statistics.
      if (entry.stage !== 'profiling') {
        if (identity !== undefined && current !== identity)
          throw new Error(
            'Observed evaluation environment or protocol changed',
          );
        identity = current;
        firstEvidence ??= evidence;
      }
      if (
        evidence.measurements.some(
          (m) => m.warmup !== manifest.warmup || m.repeat !== manifest.repeat,
        )
      )
        throw new Error('Observed timing protocol differs from manifest');
      if (firstEvidence?.id === entry.id) {
        const before = await receiptIdentity(options.manager, entry.id);
        await options.manager.run(snapshot.recipePath, {
          id: entry.id,
          resume: true,
          signal: options.signal,
        });
        if (before !== (await receiptIdentity(options.manager, entry.id)))
          throw new Error(
            'Completed resume changed receipts, measurements or usage',
          );
        await save(join(base, 'recovery.json'), {
          id: entry.id,
          receiptIdentity: before,
        });
      }
    }
    return await reportCampaign(options);
  } catch (error) {
    await save(join(base, 'last-error.json'), {
      error: error instanceof Error ? error.message : String(error),
      time: new Date().toISOString(),
    });
    throw error;
  } finally {
    await lease.release(true);
  }
}
export async function reportCampaign(
  options: Operations,
): Promise<CampaignReport> {
  const manifest = await loadCampaign(options.rootDirectory, options.id);
  const experiments: ExperimentEvidence[] = [],
    errors: CampaignReport['errors'] = [];
  const measurements: CalibrationMeasurement[] = [];
  const facts = await options.manager.facts.list('experiments');
  let evaluationRuns = 0,
    modelCalls = 0;
  for (const entry of manifest.entries) {
    const fact = facts.find((f) => f.id === entry.id);
    if (!fact) {
      errors.push({
        id: entry.id,
        status: 'not-started',
        error: 'No Manager experiment fact',
      });
      continue;
    }
    const usage = object(fact.usage ?? {});
    evaluationRuns +=
      typeof usage.evaluationRuns === 'number' ? usage.evaluationRuns : 0;
    modelCalls += typeof usage.modelCalls === 'number' ? usage.modelCalls : 0;
    try {
      await verifySnapshot(options, manifest, entry, true);
      const evidence = await readExperimentEvidence(options.manager, entry.id);
      if (
        evidence.measurements.some(
          (m) => m.warmup !== manifest.warmup || m.repeat !== manifest.repeat,
        )
      )
        throw new Error('Observed protocol differs from manifest');
      experiments.push(evidence);
      if (entry.stage === 'batch-1' || entry.stage === 'batch-2')
        measurements.push(
          ...evidence.measurements.map((m) => ({
            ...m,
            batch: entry.stage === 'batch-1' ? 1 : 2,
          })),
        );
    } catch (error) {
      errors.push({
        id: entry.id,
        status: String(fact.status),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let statistics: CalibrationStatistics | null = null;
  if (measurements.length === 20) {
    try {
      statistics = summarizeCalibration(measurements);
    } catch (error) {
      errors.push({
        id: manifest.id,
        status: 'evidence-invalid',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const first = experiments.find((e) => e.id === manifest.entries[0].id);
  if (
    first &&
    measurements.some(
      (m) =>
        m.comparisonKey !== first.measurements[0].comparisonKey ||
        m.sourceDigest !== first.measurements[0].sourceDigest,
    )
  )
    errors.push({
      id: manifest.id,
      status: 'evidence-invalid',
      error: 'Initial and formal evaluation identities differ',
    });
  try {
    const proof = await readJson(
      join(directory(options.rootDirectory, options.id), 'batch-gap.json'),
    );
    const previous = experiments.find((e) => e.id === `${manifest.id}-b1-p5`);
    if (
      !previous ||
      proof.previousId !== previous.id ||
      proof.previousFinishedAt !== previous.finishedAt ||
      proof.nextId !== `${manifest.id}-b2-p1` ||
      proof.notBefore !==
        Date.parse(previous.finishedAt) + manifest.intervalMs ||
      typeof proof.observedAt !== 'number' ||
      proof.observedAt < Number(proof.notBefore)
    )
      throw new Error('Invalid interval proof');
  } catch {
    errors.push({
      id: manifest.id,
      status: 'evidence-incomplete',
      error: 'Batch interval evidence missing or invalid',
    });
  }
  let recovery = 'unverified';
  try {
    const proof = await readJson(
      join(directory(options.rootDirectory, options.id), 'recovery.json'),
    );
    if (
      proof.id === manifest.entries[0].id &&
      proof.receiptIdentity ===
        (await receiptIdentity(options.manager, string(proof.id)))
    )
      recovery = 'verified';
  } catch {
    /* Missing recovery proof is a failed gate, not an execution request. */
  }
  const initial = experiments.find((e) => e.id === `${manifest.id}-initial`);
  let basicLoop = initial
    ? initial.fixture
      ? 'test-fixture'
      : 'passed'
    : 'incomplete';
  if (manifest.adjustment) {
    const parent = await reportCampaign({
      ...options,
      id: manifest.adjustment.parentId,
    });
    basicLoop = parent.basicLoop;
  }
  const profiling = experiments.find(
    (e) => e.id === `${manifest.id}-profiling`,
  );
  const profiler = object(object(manifest.preflight.host ?? {}).profiler ?? {});
  const toolObserved =
    profiler.status === 'observed' &&
    typeof profiler.output === 'string' &&
    profiler.output.trim().length > 0;
  const formalErrors = errors.filter(
    (e) => e.id !== `${manifest.id}-profiling`,
  );
  const report: CampaignReport = {
    id: manifest.id,
    basicLoop,
    performance:
      formalErrors.length ||
      !statistics ||
      recovery !== 'verified' ||
      (basicLoop !== 'passed' && basicLoop !== 'test-fixture')
        ? 'incomplete'
        : statistics.evidenceKind === 'test-fixture' ||
            basicLoop === 'test-fixture'
          ? 'test-fixture'
          : statistics.passed
            ? 'passed'
            : 'failed-noise',
    profiling: profiling
      ? profiling.fixture
        ? 'test-fixture'
        : profiling.profilingReady && toolObserved
          ? 'ready'
          : 'unavailable'
      : manifest.entries.some((e) => e.stage === 'profiling')
        ? 'unavailable'
        : 'not-run',
    recovery,
    measurements,
    experiments,
    statistics,
    evaluationRuns,
    modelCalls,
    errors,
    reportPath: join(directory(options.rootDirectory, options.id), 'report.md'),
  };
  await save(
    join(directory(options.rootDirectory, options.id), 'report.json'),
    report,
  );
  const fixture = experiments.some((e) => e.fixture);
  const markdown =
    `# M2 算子校准报告\n\n实验集合：${manifest.id}\n\n${fixture ? '测试证据：不构成 NPU 验收。' : '真实设备结果仍须结合环境及原始证据审阅。'}\n\n` +
    `基础闭环：${basicLoop}；性能比较：${report.performance}；完成恢复：${recovery}；profiling：${report.profiling}。\n\n` +
    `SDK 评测用量：${evaluationRuns}；模型调用：${modelCalls}。预检烟测用量单列在 manifest.preflight 中。\n\n` +
    `协议：warmup=${manifest.warmup}，repeat=${manifest.repeat}；批次间隔至少 600 秒。\n\n` +
    `|批次|实验|Measurement|SDK runId|候选 ms|参考 ms|\n|---|---|---|---|---:|---:|\n` +
    measurements
      .map(
        (m) =>
          `|${m.batch}|${m.experimentId}|${m.measurementRef}|${m.runId}|${m.candidateMs}|${m.referenceMs}|`,
      )
      .join('\n') +
    `\n\n统计（样本标准差；原始数值比较）：\n\n\`\`\`json\n${JSON.stringify(statistics, null, 2)}\n\`\`\`\n\n` +
    `未通过／未执行项：\n\n\`\`\`json\n${JSON.stringify(errors, null, 2)}\n\`\`\`\n\n保留整个 .rsi 及来源仓库；摘要报告不能代替原始 CSV、SDK 结果、Manager 事实和输入快照。\n`;
  await writeFile(report.reportPath, markdown);
  return report;
}
