import { mkdtemp, mkdir, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JsonSchema, JsonValue } from '../../contracts/index.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { errorText, redactConfiguration } from '../../shared/errors.js';
import { json, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import type { Runtime } from '../context.js';
import { Recipe } from '../loaders/recipe.js';
import { Manager } from '../manager/index.js';
import { withBindingInstance } from '../manager/instances.js';
import type {
  DoctorBinding,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
  DoctorResult,
} from '../../contracts/index.js';
import {
  doctorProgressReporter,
  type DoctorProgressObserver,
} from './progress.js';

const doctorResultSchema: JsonSchema = {
  type: 'object',
  required: ['checks'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          status: { enum: ['passed', 'failed', 'unchecked'] },
          reason: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
    missingResources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'kind', 'reference', 'checksNotRun'],
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          kind: { type: 'string' },
          reference: { type: 'string' },
          checksNotRun: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export function doctorFailure(stage: string, error: unknown): DoctorReport {
  return {
    recipeId: null,
    summary: { passed: 0, failed: 1, unchecked: 0 },
    missingResources: [],
    checks: [
      {
        id: stage,
        status: 'failed',
        reason: redactConfiguration()(errorText(error)),
      },
    ],
  };
}

export async function diagnoseBinding(
  registry: Registry,
  context: DoctorContext,
): Promise<DoctorResult> {
  const { binding, signal, directory } = context;
  try {
    const result = await withBindingInstance(
      registry,
      { plugin: binding.pluginId, config: binding.config },
      context.runtime.extend({ bindingId: binding.name, signal, directory }),
      'rsi/doctor',
      (target, event, runtime) =>
        target.serial(target, event, { ...context, runtime }),
    );
    return (
      result ?? {
        checks: [
          {
            id: 'plugin',
            status: 'unchecked',
            reason: `Binding ${binding.name}, implementation ${binding.pluginId}, has no doctor capability.`,
          },
        ],
      }
    );
  } catch (error) {
    signal.throwIfAborted();
    return {
      checks: [{ id: 'script', status: 'failed', reason: errorText(error) }],
    };
  }
}

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  runtime: Runtime,
  path: string,
  options: {
    signal?: AbortSignal;
    staticOnly?: boolean;
    onProgress?: DoctorProgressObserver;
  } = {},
): Promise<DoctorReport> {
  const signal = options.signal ?? new AbortController().signal;
  const reportProgress = doctorProgressReporter(options.onProgress);
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
  const redact = redactConfiguration({
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
  reportProgress?.({
    kind: 'recipe-validated',
    recipeId: recipe.id,
    totalBindings: bindings.length,
  });
  const temporary = await mkdtemp(join(tmpdir(), 'arsi-doctor-'));
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
    const { reason, details, ...metadata } = check;
    report.checks.push({
      ...metadata,
      ...(reason ? { reason: redact(reason) } : {}),
      ...(details ? { details: object(redactValues(details)) } : {}),
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
      const checkStart = report.checks.length;
      reportProgress?.({
        kind: 'binding-started',
        index,
        total: bindings.length,
        binding: binding.name,
        pluginId: binding.pluginId,
      });
      const emitBindingCompleted = (): void => {
        if (!reportProgress) return;
        const added = report.checks.slice(checkStart);
        let passed = 0;
        let failed = 0;
        let unchecked = 0;
        for (const item of added) {
          if (item.status === 'passed') passed += 1;
          else if (item.status === 'failed') failed += 1;
          else unchecked += 1;
        }
        reportProgress({
          kind: 'binding-completed',
          index,
          total: bindings.length,
          binding: binding.name,
          pluginId: binding.pluginId,
          passed,
          failed,
          unchecked,
          checks: added,
        });
      };
      const directory = join(temporary, `probe-${index}`);
      await mkdir(directory);
      const scoped = (id: string): string => `${binding.name}.${id}`;
      const identity = { binding: binding.name, pluginId: binding.pluginId };
      const addCheck = (check: DoctorResult['checks'][number]): void => {
        add({ ...check, ...identity, id: scoped(check.id) });
      };
      const addMissing = (
        resource: NonNullable<DoctorResult['missingResources']>[number],
      ): void => {
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
      };
      let pathsValid = true;
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
        let missing = false;
        const check = await runDoctorCheck(
          id,
          async () => {
            try {
              const info = await stat(reference);
              if (!(field.kind === 'file' ? info.isFile() : info.isDirectory()))
                throw new Error(
                  `${field.pointer}: expected ${field.kind}: ${reference}`,
                );
              await access(reference, constants.R_OK);
            } catch (error) {
              missing =
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT';
              throw error;
            }
          },
          { signal },
        );
        addCheck(check);
        if (check.status === 'failed') pathsValid = false;
        if (missing)
          addMissing({
            field: `config${field.pointer.replaceAll('/', '.')}`,
            kind: field.kind,
            reference,
            checksNotRun: options.staticOnly ? [] : ['plugin'],
          });
      }
      if (options.staticOnly || !pathsValid) {
        addCheck({
          id: 'plugin',
          status: 'unchecked',
          reason: options.staticOnly
            ? 'Component diagnostics were skipped by --static.'
            : 'Component diagnostics were skipped because a declared local path failed validation.',
        });
        emitBindingCompleted();
        continue;
      }
      const context: DoctorContext = {
        binding,
        recipe,
        registry: runtime.registry,
        directory,
        signal,
        runtime: reportProgress
          ? base.extend({
              reportProgress(update) {
                const detail = update.detail ?? update.notice;
                if (detail) {
                  reportProgress({
                    kind: 'binding-detail',
                    binding: binding.name,
                    pluginId: binding.pluginId,
                    detail: redact(detail),
                  });
                }
              },
            })
          : base,
      };
      try {
        const result = await diagnoseBinding(runtime.registry, context);
        signal.throwIfAborted();
        validate(doctorResultSchema, result, 'Doctor result');
        const ids = new Set(report.checks.map(({ id }) => id));
        const unchecked = new Set<string>();
        for (const check of result.checks) {
          if (check.details !== undefined) json(check.details);
          const id = scoped(check.id);
          if (ids.has(id)) throw new Error(`Duplicate doctor check ID: ${id}`);
          ids.add(id);
          if (check.status === 'unchecked') unchecked.add(check.id);
        }
        for (const resource of result.missingResources ?? [])
          for (const id of resource.checksNotRun)
            if (!unchecked.has(id))
              throw new Error(
                `Missing resource references a check that is not unchecked: ${scoped(id)}`,
              );
        for (const check of result.checks) addCheck(check);
        for (const resource of result.missingResources ?? [])
          addMissing(resource);
      } catch (error) {
        signal.throwIfAborted();
        addCheck({
          id: 'script',
          status: 'failed',
          reason: errorText(error),
        });
      }
      emitBindingCompleted();
    }
  } finally {
    reportProgress?.({ kind: 'cleaning' });
    try {
      await isolated.dispose();
    } catch (error) {
      add({
        id: 'doctor.cleanup.runtime',
        status: 'failed',
        reason: errorText(error),
      });
    }
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
  signal.throwIfAborted();
  for (const check of report.checks) report.summary[check.status]++;
  return report;
}
