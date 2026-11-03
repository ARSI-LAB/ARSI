import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import type { FactStore } from '../../contracts/index.js';

/** Short cross-process gate covering ownership establishment and source application. */
export interface ResourceGate {
  assertOwned(): void;
  release(): Promise<void>;
}
export async function acquireResourceGate(
  directory: string,
): Promise<ResourceGate> {
  await mkdir(directory, { recursive: true });
  let compromised: Error | undefined;
  const release = await lock(join(directory, 'resource-application'), {
    realpath: false,
    stale: 60000,
    update: 10000,
    retries: { retries: 30, minTimeout: 20, maxTimeout: 100 },
    onCompromised(error) {
      compromised = error;
    },
  });
  return {
    assertOwned() {
      if (compromised) throw compromised;
    },
    release,
  };
}

/** Called while holding the gate. Existing stale ownership requires explicit recovery. */
export async function blockingExperiments(
  directory: string,
  facts: FactStore,
): Promise<string[]> {
  const owners = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await readdir(join(directory, 'locks'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  for (const entry of entries)
    if (entry.endsWith('.lock')) owners.add(entry.slice(0, -5));
  for (const record of await facts.list('experiments')) {
    if (record.status === 'running') {
      if (typeof record.id !== 'string')
        throw new Error(
          'Unresolved experiment ownership; recover experiments before applying',
        );
      owners.add(record.id);
    }
  }
  return [...owners].sort();
}
