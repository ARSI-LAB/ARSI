import { mkdtemp, mkdir, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JsonValue } from '../../contracts/index.js';
import { configPathFields, isResourceUrl } from '../../shared/config-paths.js';
import { errorText } from '../../shared/errors.js';
import { object } from '../../shared/json.js';
import type { Runtime } from '../context.js';
import { Recipe } from '../loaders/recipe.js';
import { Manager } from '../manager/index.js';
import { ManagedEvents } from '../services/events.js';
import type {
  DoctorBinding,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
} from '../../contracts/index.js';

function redactor(value?: JsonValue): (message: string) => string {
  const secrets = new Set<string>();
  for (const [name, secret] of Object.entries(process.env))
    if (/key|token|secret|password|authorization/i.test(name) && secret)
      secrets.add(secret);
  const visit = (entry: JsonValue | undefined): void => {
    if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === 'object')
      for (const [key, child] of Object.entries(entry)) {
        if (
          /key|token|secret|password|authorization/i.test(key) &&
          typeof child === 'string'
        ) {
          secrets.add(child);
          for (const match of child.matchAll(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          )) {
            const secret = process.env[match[1]];
            if (secret) secrets.add(secret);
          }
        } else visit(child);
      }
  };
  visit(value);
  return (message) => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      if (secret.length > 0) message = message.replaceAll(secret, '[redacted]');
    return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  };
}

export function doctorFailure(stage: string, error: unknown): DoctorReport {
  return {
    recipeId: null,
    summary: { passed: 0, failed: 1, unchecked: 0 },
    missingResources: [],
    checks: [
      { id: stage, status: 'failed', reason: redactor()(errorText(error)) },
    ],
  };
}

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  runtime: Runtime,
  path: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<DoctorReport> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  let recipe: Recipe;
  try {
    recipe = await Recipe.load(resolve(path), runtime.registry);
  } catch (error) {
    signal.throwIfAborted();
    return doctorFailure('recipe.validate', error);
  }
  const report: DoctorReport = {
    recipeId: recipe.id,
    summary: { passed: 0, failed: 0, unchecked: 0 },
    missingResources: [],
    checks: [{ id: 'recipe.validate', status: 'passed' }],
  };
  const redact = redactor({
    recipe: recipe.toJSON(),
    reflection: recipe.reflection?.implementation.config ?? {},
  });
  const bindings: DoctorBinding[] = [
    recipe.application,
    ...Object.values(recipe.bindings),
  ];
  if (recipe.reflection) {
    const implementation = recipe.reflection.implementation;
    bindings.push({
      name: 'reflection',
      pluginId: implementation.ref,
      definition: runtime.registry.get(implementation.ref),
      config: implementation.config,
    });
  }
  const temporary = await mkdtemp(join(tmpdir(), 'ember-rsi-doctor-'));
  const isolated = new Manager({
    registry: runtime.registry,
    rootDirectory: runtime.context.rootDirectory,
    directory: temporary,
  });
  // Artifact references may be original inputs; every capture/write stays in probe storage.
  const artifacts = isolated.artifacts;
  const readInput = async <T>(
    local: () => Promise<T>,
    original: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await local();
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      return original();
    }
  };
  const events = new ManagedEvents({
    context: () => isolated.context,
    diagnostic: ({ error }) => {
      throw error;
    },
  });
  const denied = async (): Promise<never> => {
    throw new Error(
      'Doctor does not execute Agents, Policies, or Measurements',
    );
  };
  const base = isolated.context.extend({
    signal,
    cleanup: new AbortController().signal,
    experimentId: 'doctor',
    callId: 'doctor',
    event: events.event,
    artifacts: {
      putJson: artifacts.putJson.bind(artifacts),
      capture: artifacts.capture.bind(artifacts),
      readJson: (ref: string) =>
        readInput(
          () => artifacts.readJson(ref),
          () => runtime.context.artifacts.readJson(ref),
        ),
      materialize: (ref: string, directory: string) =>
        readInput(
          () => artifacts.materialize(ref, directory),
          () => runtime.context.artifacts.materialize(ref, directory),
        ),
    },
    invoke: denied,
    invokeAgent: denied,
    application: denied,
    recordCandidate: denied,
    readCandidate: denied,
    recordMeasurement: denied,
    readMeasurement: denied,
    withInstance: denied,
    charge: denied,
  });
  const add = (check: DoctorCheck): void => {
    if (report.checks.some((entry) => entry.id === check.id))
      throw new Error(`Duplicate doctor check ID: ${check.id}`);
    report.checks.push({
      ...check,
      ...(check.reason ? { reason: redact(check.reason) } : {}),
      ...(check.details
        ? { details: object(redactValues(check.details)) }
        : {}),
    });
  };
  const redactValues = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactValues);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, redactValues(child)]),
      );
    return value;
  };
  try {
    for (const [index, binding] of bindings.entries()) {
      signal.throwIfAborted();
      const directory = join(temporary, `probe-${index}`);
      await mkdir(directory);
      const scoped = (id: string): string => `${binding.name}.${id}`;
      const identity = { binding: binding.name, pluginId: binding.pluginId };
      const context: DoctorContext = {
        binding,
        recipe,
        registry: runtime.registry,
        directory,
        signal,
        runtime: base.extend({ directory, bindingId: binding.name }),
        async check(id, action, checkOptions) {
          signal.throwIfAborted();
          const controller = new AbortController();
          const bounded = AbortSignal.any([signal, controller.signal]);
          const timeoutMs =
            checkOptions?.timeoutMs ?? options.timeoutMs ?? 60000;
          const timer = setTimeout(
            () =>
              controller.abort(
                new Error(
                  `Probe timed out after ${timeoutMs} ms. Plugin availability is unknown.`,
                ),
              ),
            timeoutMs,
          );
          let abort: (() => void) | undefined;
          const job = Promise.resolve().then(() => action(bounded));
          try {
            await Promise.race([
              job,
              new Promise<never>((_done, reject) => {
                abort = () => reject(bounded.reason);
                if (bounded.aborted) abort();
                else bounded.addEventListener('abort', abort, { once: true });
              }),
            ]);
            add({
              id: scoped(id),
              ...identity,
              status: 'passed',
              ...(checkOptions?.reason ? { reason: checkOptions.reason } : {}),
              ...(checkOptions?.details
                ? { details: checkOptions.details }
                : {}),
            });
            return true;
          } catch (error) {
            let completionError: unknown;
            // Cooperating probes settle their finally blocks before temporary storage is removed.
            if (bounded.aborted) {
              let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
              const settled = await Promise.race([
                job.then(
                  () => true,
                  (cause: unknown) => {
                    if (cause !== bounded.reason) completionError = cause;
                    return true;
                  },
                ),
                new Promise<false>((done) => {
                  cleanupTimer = setTimeout(() => done(false), 15000);
                }),
              ]);
              clearTimeout(cleanupTimer);
              if (!settled)
                add({
                  id: scoped(`${id}.cleanup`),
                  ...identity,
                  status: 'failed',
                  reason:
                    'Probe did not settle after cancellation; cleanup could not be confirmed.',
                });
            }
            signal.throwIfAborted();
            add({
              id: scoped(id),
              ...identity,
              status: 'failed',
              reason: checkOptions?.reason
                ? `${checkOptions.reason}${completionError === undefined ? '' : ` Probe completion/cleanup: ${errorText(completionError)}`}`
                : `${errorText(error)}${completionError === undefined ? '' : ` Probe completion/cleanup: ${errorText(completionError)}`} Plugin availability is unknown unless established by another check.`,
              ...(checkOptions?.details
                ? { details: checkOptions.details }
                : {}),
            });
            return false;
          } finally {
            clearTimeout(timer);
            if (abort) bounded.removeEventListener('abort', abort);
          }
        },
        unchecked(id, reason, details) {
          add({
            id: scoped(id),
            ...identity,
            status: 'unchecked',
            reason,
            ...(details ? { details } : {}),
          });
        },
        missing(resource) {
          const field =
            resource.field.startsWith(`${binding.name}.`) ||
            resource.field.startsWith('application.config.')
              ? resource.field
              : `${binding.name}.${resource.field.startsWith('config.') ? '' : 'config.'}${resource.field}`;
          const item = {
            ...resource,
            field,
            ...identity,
            reference: redact(resource.reference),
            checksNotRun: resource.checksNotRun.map(scoped),
          };
          const previous = report.missingResources.find(
            (known) =>
              known.binding === item.binding &&
              known.field === item.field &&
              known.kind === item.kind &&
              known.reference === item.reference,
          );
          if (previous)
            previous.checksNotRun = [
              ...new Set([...previous.checksNotRun, ...item.checksNotRun]),
            ];
          else report.missingResources.push(item);
        },
      };
      for (const field of configPathFields(
        binding.definition.configSchema,
        binding.config,
      )) {
        let value: JsonValue = binding.config;
        for (const part of field.pointer.slice(1).split('/')) {
          const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
          if (value === null || typeof value !== 'object')
            throw new Error(`Invalid resolved path ${field.pointer}`);
          value = Array.isArray(value) ? value[Number(key)] : value[key];
        }
        if (typeof value !== 'string' || isResourceUrl(value)) continue;
        const reference = value;
        const id = `resource${field.pointer.replaceAll('/', '.')}`;
        await context.check(id, async () => {
          try {
            const info = await stat(reference);
            if (!(field.kind === 'file' ? info.isFile() : info.isDirectory()))
              throw new Error(
                `${field.pointer}: expected ${field.kind}: ${reference}`,
              );
            await access(reference, constants.R_OK);
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              context.missing({
                field: `${binding.name}.config${field.pointer.replaceAll('/', '.')}`,
                kind: field.kind,
                reference,
                checksNotRun: [],
              });
            throw error;
          }
        });
      }
      const doctor = binding.definition.doctor;
      if (!doctor)
        context.unchecked(
          'plugin',
          `Binding ${binding.name}, implementation ${binding.pluginId}, has no doctor capability; registration, contract, and configuration were validated.`,
        );
      else {
        try {
          await doctor(context);
        } catch (error) {
          signal.throwIfAborted();
          add({
            id: scoped('script'),
            ...identity,
            status: 'failed',
            reason: `${errorText(error)} Plugin availability is unknown.`,
          });
        }
      }
    }
  } finally {
    const cleanups = await Promise.allSettled([
      isolated.dispose(),
      events.dispose(),
    ]);
    for (const [index, cleanup] of cleanups.entries())
      if (cleanup.status === 'rejected')
        add({
          id: `doctor.cleanup.${index}`,
          status: 'failed',
          reason: errorText(cleanup.reason),
        });
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      add({
        id: 'doctor.cleanup.storage',
        status: 'failed',
        reason: errorText(error),
      });
    }
  }
  for (const resource of report.missingResources)
    for (const id of resource.checksNotRun)
      if (
        !report.checks.some(
          (check) => check.id === id && check.status === 'unchecked',
        )
      )
        throw new Error(
          `Missing resource references a check that is not unchecked: ${id}`,
        );
  for (const check of report.checks) report.summary[check.status]++;
  return report;
}
