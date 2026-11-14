import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Candidate,
  DoctorContext,
  DoctorResult,
  Operation,
} from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
import { object, string } from '../../../shared/json.js';
import { parseConfig } from '../../../shared/schema.js';
import { readTarget, type FileApplicationConfig } from './files.js';

/** Validate target content without initializing the application or acquiring an instance. */
export async function checkStaticFileApplication(
  context: DoctorContext,
): Promise<DoctorResult> {
  const check = await runDoctorCheck(
    'target-schema',
    async (signal) => {
      const config = parseConfig<FileApplicationConfig>(
        context.binding.definition.configSchema,
        context.binding.config,
        `${context.binding.name}.config`,
      );
      await readTarget(config, context.runtime.rootDirectory);
      signal.throwIfAborted();
    },
    { signal: context.signal },
  );
  return { checks: [check] };
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

type MissingInput = NonNullable<DoctorResult['missingResources']>[number];

export async function requirePath(
  missingResources: MissingInput[],
  path: string,
  field: string,
  kind: 'file' | 'directory',
  checksNotRun: string[] = [],
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`${field}: expected a readable ${kind}: ${path}`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (missing(error))
      missingResources.push({
        field,
        kind,
        reference: path,
        checksNotRun,
      });
    throw error;
  }
}

export async function checkBaselineDirectory(
  context: DoctorContext,
  dependents: string[],
  entryFile?: string,
): Promise<{
  check: DoctorResult['checks'][number];
  directory?: string;
  missingResources: MissingInput[];
}> {
  const missingResources: MissingInput[] = [];
  let baselineDirectory: string | undefined;
  const check = await runDoctorCheck(
    'baseline',
    async (signal) => {
      const config = parseConfig<FileApplicationConfig>(
        context.binding.definition.configSchema,
        context.binding.config,
        `${context.binding.name}.config`,
      );
      if (typeof config.target.schema === 'string')
        await requirePath(
          missingResources,
          config.target.schema,
          'target.schema',
          'file',
          dependents,
        );
      const { target } = await readTarget(
        config,
        context.runtime.rootDirectory,
      );
      let directory: string;
      if ('directory' in config.baseline) {
        directory = resolve(
          context.runtime.rootDirectory,
          config.baseline.directory,
        );
        await requirePath(
          missingResources,
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
            missingResources.push({
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
            missingResources,
            join(directory, entry.path),
            `target.entries.${entry.path}`,
            'file',
            dependents,
          );
      if (entryFile)
        await requirePath(
          missingResources,
          join(directory, entryFile),
          `baseline.${entryFile}`,
          'file',
          dependents,
        );
      signal.throwIfAborted();
      baselineDirectory = directory;
    },
    { signal: context.signal },
  );
  return {
    check,
    directory: check.status === 'passed' ? baselineDirectory : undefined,
    missingResources: [...missingResources],
  };
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
): Promise<DoctorResult> {
  const baseline = await checkBaselineDirectory(
    context,
    [verification, 'acquire-instance'],
    entryFile,
  );
  const checks = [baseline.check];
  const result = { checks, missingResources: baseline.missingResources };
  if (!baseline.directory) {
    const reason = 'Baseline or Target prerequisites failed.';
    checks.push(
      { id: verification, status: 'unchecked', reason },
      { id: 'acquire-instance', status: 'unchecked', reason },
    );
    return result;
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
    const verified = await runDoctorCheck(
      verification,
      async (signal) => {
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
        candidateRef = string(
          result.initialCandidateRef,
          'initialCandidateRef',
        );
      },
      { signal: context.signal },
    );
    checks.push(verified);
    if (verified.status !== 'passed' || !operation || !candidateRef) {
      checks.push({
        id: 'acquire-instance',
        status: 'unchecked',
        reason: 'Application initialization did not complete.',
      });
      return result;
    }
    const application = operation;
    const initialCandidateRef = candidateRef;
    checks.push(
      await runDoctorCheck(
        'acquire-instance',
        async (signal) => {
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
            const directory = string(
              execution.directory,
              'execution.directory',
            );
            await access(directory, constants.R_OK);
            await readFile(join(directory, entryFile), {
              encoding: 'utf8',
              signal,
            });
            signal.throwIfAborted();
          } finally {
            if (acquired) {
              await application.execute(
                { action: 'release', instanceId },
                runtime.extend({ signal: runtime.cleanup }),
              );
              const instance = await runtime.facts.read(
                'instances',
                instanceId,
              );
              if (instance.status !== 'released')
                throw new Error(
                  'Application instance release was not confirmed',
                );
            }
          }
        },
        { signal: context.signal },
      ),
    );
  } finally {
    if (operation) {
      const application = operation;
      checks.push(
        await runDoctorCheck('cleanup', async () => application.dispose(), {
          signal: runtime.cleanup,
        }),
      );
    }
    context.signal.throwIfAborted();
  }
  return result;
}
