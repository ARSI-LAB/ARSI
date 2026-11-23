import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FileTreeFile } from '../../contracts/index.js';
import { object, string, strings } from '../../shared/json.js';
import { atomic } from '../storage/index.js';
import { directoryFingerprint } from '../storage/directory-fingerprint.js';
import { renameFileWithRetry } from '../storage/rename-file.js';
import type { ResourceGate } from './exclusion.js';
import {
  absent,
  inspectPath,
  stat,
  validateSnapshotDestination,
} from './snapshot-paths.js';
import { pathContains } from './resources.js';

export interface SnapshotTarget {
  path: string;
  kind: 'file' | 'directory';
  files: FileTreeFile[];
}
interface Entry {
  path: string;
  kind: 'file' | 'directory';
  original: string | null;
  staged: string | null;
}
interface Journal {
  id: string;
  project: string;
  phase: 'preparing' | 'publishing' | 'committed';
  entries: Entry[];
  parents: string[];
}
const journalPath = (directory: string): string =>
  join(directory, 'snapshot-publication.json');
const staging = (journal: Journal, index: number): string =>
  join(
    dirname(journal.entries[index]!.path),
    `.rsi-apply-${journal.id}-${index}`,
  );
async function identity(path: string): Promise<string | null> {
  try {
    const entry = await lstat(path, { bigint: true });
    if (!(entry.isDirectory() || entry.isFile()))
      throw new Error('Unexpected snapshot entry: ' + path);
    return entry.isFile()
      ? 'file/' +
          String(entry.mode & 0o777n) +
          '/' +
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
      : 'directory/' +
          entry.dev +
          '/' +
          entry.ino +
          '/' +
          (await directoryFingerprint(path));
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

function parseJournal(raw: unknown): Journal {
  const data = object(raw, 'snapshot publication journal');
  const id = string(data.id);
  if (
    !/^[a-f\d-]{36}$/.test(id) ||
    !Array.isArray(data.entries) ||
    (data.phase !== 'preparing' &&
      data.phase !== 'publishing' &&
      data.phase !== 'committed')
  )
    throw new Error('Invalid snapshot publication journal');
  return {
    id,
    project: string(data.project),
    phase: data.phase,
    parents: strings(data.parents),
    entries: data.entries.map((value) => {
      const entry = object(value);
      if (entry.kind !== 'file' && entry.kind !== 'directory')
        throw new Error('Invalid snapshot resource kind');
      return {
        path: string(entry.path),
        kind: entry.kind,
        original: entry.original === null ? null : string(entry.original),
        staged: entry.staged === null ? null : string(entry.staged),
      };
    }),
  };
}

async function stage(target: SnapshotTarget, next: string): Promise<void> {
  const directoryModes = new Map<string, number>();
  if (target.kind === 'directory') await mkdir(next);
  for (const file of target.files) {
    const path = target.kind === 'directory' ? join(next, file.path) : next;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.base64, 'base64'), {
      flag: 'wx',
      mode: file.mode,
    });
    if (process.platform !== 'win32') {
      await chmod(path, file.mode);
      for (
        let current = dirname(path);
        pathContains(next, current) && !directoryModes.has(current);
        current = dirname(current)
      ) {
        const oldPath = join(target.path, relative(next, current));
        const info = await lstat(oldPath).catch((error: unknown) => {
          if (
            absent(error) ||
            (error instanceof Error &&
              'code' in error &&
              error.code === 'ENOTDIR')
          )
            return undefined;
          throw error;
        });
        if (info?.isDirectory()) directoryModes.set(current, info.mode & 0o777);
      }
    }
  }
  if (target.kind === 'directory' && process.platform !== 'win32') {
    const old = await stat(target.path);
    if (old) directoryModes.set(next, old.mode & 0o777);
    for (const [path, mode] of [...directoryModes].sort(
      ([a], [b]) => b.length - a.length,
    ))
      await chmod(path, mode);
  }
}

async function removeStaging(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EACCES'))
      throw error;
    // A replaced source can contain read-only directories. Reclaim permissions
    // only on directories already moved inside the transaction's private area.
    const release = async (directory: string): Promise<void> => {
      const info = await stat(directory);
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      await chmod(directory, (info.mode & 0o777) | 0o700);
      for (const name of await readdir(directory))
        await release(join(directory, name));
    };
    await release(path);
    await rm(path, { recursive: true, force: true });
  }
}

/** The experiment gate serializes recovery, publication, and reading a Recipe's sources. */
export async function recoverSnapshotPublication(
  directory: string,
  gate: ResourceGate,
): Promise<void> {
  let journal: Journal;
  try {
    journal = parseJournal(
      JSON.parse(await readFile(journalPath(directory), 'utf8')),
    );
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  for (let index = journal.entries.length - 1; index >= 0; index--) {
    const entry = journal.entries[index]!;
    if (!isAbsolute(entry.path) || resolve(entry.path) !== entry.path)
      throw new Error('Invalid snapshot destination: ' + entry.path);
    await validateSnapshotDestination(
      entry.path,
      entry.kind,
      journal.project,
      directory,
    );
    const temp = staging(journal, index),
      next = join(temp, 'next'),
      backup = join(temp, 'previous');
    await inspectPath(temp);
    gate.assertOwned();
    if (journal.phase === 'publishing') {
      const current = await identity(entry.path);
      const previous = await identity(backup);
      if (previous !== null && previous !== entry.original)
        throw new Error('Original snapshot backup changed: ' + backup);
      const check = async (): Promise<void> => {
        await inspectPath(entry.path);
        await inspectPath(temp);
        gate.assertOwned();
      };
      if (
        current === entry.staged &&
        current !== null &&
        current !== entry.original
      ) {
        if (entry.original && !previous)
          throw new Error('Missing original snapshot backup: ' + backup);
        if (entry.kind === 'file' && previous)
          await renameFileWithRetry(backup, entry.path, check);
        else {
          await renameFileWithRetry(entry.path, next, check);
          if (previous) await renameFileWithRetry(backup, entry.path, check);
        }
      } else if (current === null && previous) {
        await renameFileWithRetry(backup, entry.path, check);
      } else if (current !== entry.original) {
        throw new Error(
          'Snapshot destination changed during recovery: ' +
            entry.path +
            ' (backup: ' +
            backup +
            ')',
        );
      }
    }
    gate.assertOwned();
    await removeStaging(temp);
  }
  if (journal.phase !== 'committed')
    for (const path of [...journal.parents].reverse()) {
      if (
        !journal.entries.some((entry) =>
          pathContains(path, dirname(entry.path)),
        ) ||
        resolve(path) === resolve(path, '..')
      )
        throw new Error('Invalid snapshot parent directory: ' + path);
      await validateSnapshotDestination(
        path,
        'directory',
        journal.project,
        directory,
      );
      gate.assertOwned();
      await rmdir(path).catch((error: unknown) => {
        if (
          !absent(error) &&
          !(
            error instanceof Error &&
            'code' in error &&
            ['ENOTEMPTY', 'EEXIST'].includes(String(error.code))
          )
        )
          throw error;
      });
    }
  gate.assertOwned();
  await unlink(journalPath(directory));
}

/** Stage every replacement on its destination volume before publishing any resource. */
export async function publishSnapshots(
  directory: string,
  project: string,
  gate: ResourceGate,
  targets: SnapshotTarget[],
  parents: string[],
): Promise<void> {
  const journal: Journal = {
    id: randomUUID(),
    project,
    phase: 'preparing',
    parents,
    entries: [],
  };
  for (const target of targets)
    journal.entries.push({
      path: target.path,
      kind: target.kind,
      original: await identity(target.path),
      staged: null,
    });
  const persist = async (): Promise<void> => {
    gate.assertOwned();
    await atomic(journalPath(directory), journal);
  };
  await persist();
  try {
    for (const path of parents) {
      await inspectPath(path);
      gate.assertOwned();
      await mkdir(path);
    }
    for (const [index, target] of targets.entries()) {
      const temp = staging(journal, index),
        next = join(temp, 'next');
      await inspectPath(dirname(temp));
      gate.assertOwned();
      await mkdir(temp);
      await stage(target, next);
      journal.entries[index]!.staged = await identity(next);
    }
    journal.phase = 'publishing';
    await persist();
    for (const [index, entry] of journal.entries.entries()) {
      const temp = staging(journal, index),
        next = join(temp, 'next'),
        backup = join(temp, 'previous');
      const check = async (): Promise<void> => {
        await validateSnapshotDestination(
          entry.path,
          entry.kind,
          project,
          directory,
        );
        await inspectPath(temp);
        gate.assertOwned();
      };
      await check();
      if ((await identity(entry.path)) !== entry.original)
        throw new Error('Snapshot destination changed: ' + entry.path);
      if (entry.original) {
        if (entry.kind === 'file') {
          const copying = join(temp, 'copy');
          await copyFile(entry.path, copying);
          await renameFileWithRetry(copying, backup, check);
        } else await renameFileWithRetry(entry.path, backup, check);
      }
      await renameFileWithRetry(next, entry.path, check);
    }
    journal.phase = 'committed';
    await persist();
  } finally {
    await recoverSnapshotPublication(directory, gate);
  }
}
