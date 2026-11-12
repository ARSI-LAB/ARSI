import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { object, string } from '../../shared/json.js';
import { executablePath } from '../shared/doctor/executable.js';
import { runCommand } from '../shared/doctor/process.js';
import {
  checkBaselineDirectory,
  requirePath,
} from '../shared/file-application/doctor.js';
import { safePath } from '../shared/file-application/target.js';

export async function checkInferenceApplication(
  context: DoctorContext,
): Promise<DoctorResult> {
  const {
    check,
    directory: baseline,
    missingResources,
  } = await checkBaselineDirectory(context, ['launch-prerequisites']);
  const checks = [check];
  if (!baseline) {
    checks.push({
      id: 'launch-prerequisites',
      status: 'unchecked',
      reason: 'Baseline or Target prerequisites failed.',
    });
    return { checks, missingResources };
  }
  checks.push(
    await runDoctorCheck(
      'launch-prerequisites',
      async (signal) => {
        const config = context.binding.config;
        if (config.remote !== undefined) {
          const remote = object(config.remote);
          const executable =
            remote.executable === undefined
              ? 'python3'
              : string(remote.executable);
          await executablePath(executable, process.cwd());
          await runCommand(executable, ['--version'], { signal });
          await requirePath(
            missingResources,
            string(remote.script),
            'remote.script',
            'file',
          );
          const parameters = join(
            baseline,
            safePath(remote.parametersFile ?? 'tuning.json'),
          );
          await requirePath(
            missingResources,
            parameters,
            'remote.parametersFile',
            'file',
          );
          object(
            JSON.parse(
              await readFile(parameters, { encoding: 'utf8', signal }),
            ),
            'remote parameters',
          );
        } else {
          const start = object(config.start);
          const resources = object(config.resources ?? {});
          if (!Array.isArray(start.argv))
            throw new Error('start.argv must be an array');
          const expand = (value: unknown): string => {
            if (typeof value === 'string') return value;
            const token = object(value, 'start.argv token');
            const resource = string(token.resource);
            const base =
              resource === 'workspace'
                ? baseline
                : resource === 'port'
                  ? '0'
                  : string(resources[resource], `resources.${resource}`);
            return token.path === undefined
              ? base
              : join(base, safePath(token.path));
          };
          const argv = start.argv.map(expand);
          const cwd =
            start.cwd === undefined
              ? baseline
              : join(baseline, safePath(start.cwd));
          await requirePath(missingResources, cwd, 'start.cwd', 'directory');
          await executablePath(string(argv[0], 'start.argv[0]'), cwd);
          for (const [index, value] of start.argv.entries()) {
            if (typeof value === 'object' && value !== null) {
              const token = object(value);
              if (token.resource !== 'port') {
                const reference = resolve(cwd, expand(value));
                await access(reference, constants.R_OK).catch(
                  (error: unknown) => {
                    if (
                      error instanceof Error &&
                      'code' in error &&
                      error.code === 'ENOENT'
                    )
                      missingResources.push({
                        field: `start.argv.${index}`,
                        kind: 'path',
                        reference,
                        checksNotRun: [],
                      });
                    throw error;
                  },
                );
              }
            }
          }
        }
        const credentials = object(config.credentials ?? {});
        if (credentials.apiKeyEnv !== undefined) {
          const name = string(credentials.apiKeyEnv);
          if (!process.env[name]?.trim())
            throw new Error(
              `credentials.apiKeyEnv references missing or empty environment variable ${name}`,
            );
        }
        // Creation validates launch settings but leaves service ownership to acquire.
        const operation = await context.binding.definition.create(
          config,
          context.runtime.extend({ signal }),
        );
        await operation.dispose();
        signal.throwIfAborted();
      },
      { signal: context.signal },
    ),
  );
  return { checks, missingResources: [...missingResources] };
}
