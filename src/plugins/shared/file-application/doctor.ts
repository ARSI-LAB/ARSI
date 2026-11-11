import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Candidate,
  DoctorContext,
  Operation,
} from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { parseConfig } from '../../../shared/schema.js';
import { readTarget, type FileApplicationConfig } from './files.js';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function requirePath(
  context: DoctorContext,
  path: string,
  field: string,
  kind: 'file' | 'directory',
  dependents: string[],
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`${field}: expected a readable ${kind}: ${path}`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (missing(error))
      context.missing({
        field,
        kind,
        reference: path,
        checksNotRun: dependents,
      });
    throw error;
  }
}

export async function checkBaselineDirectory(
  context: DoctorContext,
  dependents: string[],
  entryFile?: string,
): Promise<string | undefined> {
  let result: string | undefined;
  const ready = await context.check('baseline', async (signal) => {
    const config = parseConfig<FileApplicationConfig>(
      context.binding.definition.configSchema,
      context.binding.config,
      `${context.binding.name}.config`,
    );
    if (typeof config.target.schema === 'string')
      await requirePath(
        context,
        config.target.schema,
        'target.schema',
        'file',
        dependents,
      );
    const { target } = await readTarget(config, context.runtime.rootDirectory);
    let directory: string;
    if ('directory' in config.baseline) {
      directory = resolve(
        context.runtime.rootDirectory,
        config.baseline.directory,
      );
      await requirePath(
        context,
        directory,
        'baseline.directory',
        'directory',
        dependents,
      );
    } else {
      directory = join(context.directory, 'baseline-input');
      try {
        await context.runtime.artifacts.materialize(
          config.baseline.artifactRef,
          directory,
        );
      } catch (error) {
        if (missing(error))
          context.missing({
            field: 'baseline.artifactRef',
            kind: 'artifact',
            reference: config.baseline.artifactRef,
            checksNotRun: dependents,
          });
        throw error;
      }
    }
    for (const entry of target.entries)
      if (entry.kind === 'file')
        await requirePath(
          context,
          join(directory, entry.path),
          `target.entries.${entry.path}`,
          'file',
          dependents,
        );
    if (entryFile)
      await requirePath(
        context,
        join(directory, entryFile),
        `baseline.${entryFile}`,
        'file',
        dependents,
      );
    signal.throwIfAborted();
    result = directory;
  });
  return ready ? result : undefined;
}

export async function checkFileApplication(
  context: DoctorContext,
  {
    verification,
    capability,
    entryFile,
  }: {
    verification: string;
    capability: string;
    entryFile: string;
  },
): Promise<void> {
  const baseline = await checkBaselineDirectory(
    context,
    [verification, 'acquire-instance'],
    entryFile,
  );
  if (!baseline) {
    context.unchecked(verification, 'Baseline or Target prerequisites failed.');
    context.unchecked(
      'acquire-instance',
      'Baseline or Target prerequisites failed.',
    );
    return;
  }
  const candidates = new Map<string, Candidate>();
  const runtime = context.runtime.extend({
    experimentId: `doctor-${randomUUID()}`,
    async recordCandidate(
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string> {
      const ref = `doctor-candidate-${randomUUID()}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
    async readCandidate(ref: string): Promise<Candidate> {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error(`Unknown doctor candidate ${ref}`);
      return candidate;
    },
  });
  let operation: Operation | undefined;
  let candidateRef: string | undefined;
  try {
    const verified = await context.check(verification, async (signal) => {
      const scope = runtime.extend({ signal });
      operation = await context.binding.definition.create(
        context.binding.config,
        scope,
      );
      const result = object(
        await operation.execute({ action: 'initialize' }, scope),
      );
      if (result.action !== 'initialize')
        throw new Error('Application returned no initialization result');
      candidateRef = string(result.initialCandidateRef, 'initialCandidateRef');
    });
    if (!verified || !operation || !candidateRef) {
      context.unchecked(
        'acquire-instance',
        'Application initialization did not complete.',
      );
      return;
    }
    const application = operation;
    const initialCandidateRef = candidateRef;
    await context.check('acquire-instance', async (signal) => {
      const instanceId = `doctor-instance-${randomUUID()}`;
      const scope = runtime.extend({ signal });
      let acquired = false;
      try {
        const result = object(
          await application.execute(
            {
              action: 'acquire',
              candidateRef: initialCandidateRef,
              instanceId,
              capability,
            },
            scope,
          ),
        );
        acquired = true;
        const execution = object(result.execution, 'execution');
        const directory = string(execution.directory, 'execution.directory');
        await access(directory, constants.R_OK);
        await readFile(join(directory, entryFile), 'utf8');
        signal.throwIfAborted();
      } finally {
        if (acquired) {
          await application.execute(
            { action: 'release', instanceId },
            runtime.extend({ signal: runtime.cleanup }),
          );
          const instance = await runtime.facts.read('instances', instanceId);
          if (instance.status !== 'released')
            throw new Error('Application instance release was not confirmed');
        }
      }
    });
  } finally {
    if (operation) {
      const application = operation;
      if (context.signal.aborted) await application.dispose();
      else await context.check('cleanup', async () => application.dispose());
    }
  }
}
