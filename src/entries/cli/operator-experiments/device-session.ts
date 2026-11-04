import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manager } from '../../../runtime/manager/index.js';
import { FileArtifacts, FileFacts } from '../../../runtime/storage/index.js';
import { object, string } from '../../../shared/json.js';

type DeviceFacts = Pick<Manager, 'facts' | 'artifacts'>;

/** Manager facts remain authoritative across campaign IDs, including failed calls. */
async function assertSettled(reader: DeviceFacts): Promise<void> {
  const calls = (await reader.facts.list('calls')).filter(
    (c) => c.pluginId === 'evaluator.operatorbench',
  );
  const measurements = (await reader.facts.list('measurements')).filter(
    (m) => object(m.evaluator ?? {}).pluginId === 'evaluator.operatorbench',
  );
  for (const call of calls) {
    if (
      call.status === 'running' ||
      call.status === 'unknown' ||
      !measurements.some((m) => m.callId === call.callId)
    )
      throw new Error(
        `Unresolved operator call ${String(call.callId ?? call.experimentId)}; inspect device ownership and receipts`,
      );
  }
  for (const measurement of measurements) {
    if (measurement.status === 'unknown' || measurement.status === 'running')
      throw new Error(
        `Unresolved operator measurement ${String(measurement.ref)}; device cleanup unknown`,
      );
    if (measurement.provenance !== undefined) {
      const provenance = object(
        await reader.artifacts.readJson(
          string(object(measurement.provenance).artifactRef),
        ),
      );
      if (provenance.mode === 'sdk' && provenance.cleanup !== 'confirmed')
        throw new Error(
          `Unresolved operator cleanup ${String(measurement.ref)}`,
        );
    }
  }
  const experiments = new Set(
    [...calls, ...measurements].map((item) => item.experimentId),
  );
  if (
    (await reader.facts.list('cleanup')).some(
      (c) => experiments.has(c.experimentId) && c.status === 'unconfirmed',
    )
  )
    throw new Error('Unresolved operator cleanup receipt');
  if (
    (await reader.facts.list('instances')).some(
      (i) => experiments.has(i.experimentId) && i.status !== 'released',
    )
  )
    throw new Error('Unresolved operator instance ownership');
}

/** One workspace owns one device session; uncertain owners survive normal exit and crashes. */
export async function acquireDeviceSession(options: {
  rootDirectory: string;
  owner: string;
  reader?: DeviceFacts;
}): Promise<{ release(cleanupConfirmed: boolean): Promise<void> }> {
  const base = join(options.rootDirectory, '.rsi/operator-calibration');
  const lock = join(base, 'device.lock');
  await mkdir(base, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Device has an active or unconfirmed owner; inspect device.lock before any new device work',
      );
    throw error;
  }
  const reader = options.reader ?? {
    facts: new FileFacts(join(options.rootDirectory, '.rsi/facts')),
    artifacts: new FileArtifacts(join(options.rootDirectory, '.rsi/artifacts')),
  };
  const owner = {
    owner: options.owner,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const record = async (
    status: string,
    reason: string | null,
  ): Promise<void> => {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ ...owner, status, reason }, null, 2) + '\n',
    );
  };
  try {
    await record('running', null);
    await assertSettled(reader);
  } catch (error) {
    await record(
      'unknown',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  return {
    async release(cleanupConfirmed: boolean): Promise<void> {
      if (!cleanupConfirmed) {
        await record(
          'unknown',
          'Device execution or cleanup was not confirmed',
        );
        return;
      }
      try {
        await assertSettled(reader);
      } catch (error) {
        await record(
          'unknown',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      await rm(lock, { recursive: true });
    },
  };
}
