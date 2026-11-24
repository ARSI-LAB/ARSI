import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Evaluator, loadConfig, type CleanupOptions } from 'arsi-evaluator';
import type {
  CallProgressUpdate,
  CleanupContext as BindingCleanupContext,
  CleanupResult,
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../../contracts/index.js';
import { errorText } from '../../../shared/errors.js';
import { digest, object, string } from '../../../shared/json.js';
import { evaluatorNetworkConfigPath } from './configuration.js';
import { clone, redact } from './data.js';

type CleanupContext = Pick<
  RuntimeContext,
  'experimentId' | 'dataDirectory' | 'facts' | 'signal'
> & {
  reportProgress?(update: CallProgressUpdate): void;
};
export type EvaluatorCleanupSource =
  | {
      context: RuntimeContext;
      kind: 'agentbundle';
      workspaceRef: JsonValue | undefined;
    }
  | { context: RuntimeContext; kind: 'kernel' };

type CleanupOutcome = Omit<CleanupResult, 'key'>;

interface CleanupRequest {
  binding: { id: string; kind: EvaluatorCleanupSource['kind'] };
  dryRun?: boolean;
}

const callKey = /^(call-[0-9a-f]{32})(?:-([0-9a-f]{24}))?$/;

function cleanupReceiptKind(experimentId: string): string {
  return `evaluator-cleanup-${experimentId}`;
}

async function* cleanupReceipts(context: CleanupContext) {
  // A resumed call can have both receipts. Its current registration takes precedence.
  const seen = new Set<JsonValue>();
  for (const kind of [
    cleanupReceiptKind(context.experimentId),
    `evaluator-images-${context.experimentId}`,
  ]) {
    const receipts =
      context.facts.scan?.(kind) ?? (await context.facts.list(kind));
    for await (const entry of receipts) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      yield { kind, entry };
    }
  }
}

function configPath(
  context: CleanupContext,
  key: string,
  kind: EvaluatorCleanupSource['kind'],
): string | undefined {
  const match = callKey.exec(key);
  if (!match) return undefined;
  return join(
    context.dataDirectory,
    'experiments',
    context.experimentId,
    'calls',
    match[1],
    ...(match[2] ? ['attempts', match[2]] : []),
    kind === 'kernel' ? 'sdk-config.json' : 'evaluator.json',
  );
}

function cleanupTarget(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  env: NodeJS.ProcessEnv,
): string {
  const location = (value: string | undefined) =>
    value ? resolve(value) : null;
  const { services: _services, ...settings } = loaded.experiment;
  return digest(
    clone({
      settings,
      deployment: loaded.deployment ?? null,
      home: homedir(),
      cache: location(env.EVALUATOR_CACHE_DIR),
      cacheHome: location(env.XDG_CACHE_HOME ?? env.LOCALAPPDATA),
      dockerHost: env.DOCKER_HOST ?? null,
      dockerContext: env.DOCKER_CONTEXT ?? null,
      dockerConfig: location(env.DOCKER_CONFIG),
      networkConfig: location(env.EVALUATOR_NETWORK_CONFIG),
    }),
  );
}

/** Record the SDK input before evaluation can acquire resources. */
export async function recordCleanupInput(
  source: EvaluatorCleanupSource,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { context, kind } = source;
  const key = context.idempotencyKey;
  // Standalone plugin callers provide their own directories and own their cleanup.
  if (path !== configPath(context, key, kind)) return;
  const input = await readFile(path, 'utf8');
  const loaded = await loadConfig(path, {}, env, { allowMissingAuth: true });
  if (loaded.experiment.environment.name !== 'docker') return;
  let ownerPath: string | null = null;
  if (source.kind === 'kernel') {
    ownerPath = join(context.directory, 'sdk-input', 'manifest.json');
  } else if (
    typeof source.workspaceRef === 'string' &&
    /^[0-9a-f-]{36}$/.test(source.workspaceRef)
  ) {
    const definition = await context.facts.read(
      'definitions',
      context.experimentId,
    );
    if (
      object(object(definition.recipe).application).plugin ===
      'application.agentbundle'
    )
      ownerPath = join(
        context.dataDirectory,
        'workspaces',
        source.workspaceRef,
        'files',
      );
  }
  await context.facts.write(cleanupReceiptKind(context.experimentId), key, {
    experimentId: context.experimentId,
    bindingId: context.bindingId,
    key,
    kind,
    ownerPath,
    inputDigest: digest(input),
    targetDigest: cleanupTarget(loaded, env),
    status: 'pending',
    attempts: [],
  });
}

function cleanupResult(value: unknown, dryRun: boolean): CleanupOutcome {
  const report = object(value, 'Evaluator cleanup report');
  if (
    typeof report.preview !== 'boolean' ||
    !Array.isArray(report.nodes) ||
    !report.nodes.length
  )
    throw new Error('Evaluator returned an invalid cleanup report');
  let pending = report.preview !== dryRun;
  for (const raw of report.nodes) {
    const node = object(raw, 'cleanup node');
    if (
      typeof node.nodeId !== 'string' ||
      typeof node.daemonId !== 'string' ||
      !Array.isArray(node.items)
    )
      throw new Error('Invalid Evaluator cleanup node');
    if (node.error !== undefined) pending = true;
    for (const rawItem of node.items) {
      const item = object(rawItem, 'cleanup item');
      if (
        typeof item.reference !== 'string' ||
        typeof item.imageId !== 'string' ||
        typeof item.reason !== 'string' ||
        !['candidate', 'deleted', 'retained', 'skipped', 'failed'].includes(
          String(item.status),
        )
      )
        throw new Error('Invalid Evaluator cleanup item');
      if (
        item.status === 'failed' ||
        (!dryRun && item.status !== 'deleted' && item.status !== 'retained')
      )
        pending = true;
    }
  }
  return {
    status: pending ? 'pending' : dryRun ? 'preview' : 'complete',
    report: object(redact(report)),
  };
}

/** Follow the call's retry chain to the exact attempt that wrote an older input. */
async function recordedBinding(
  context: CleanupContext,
  entry: JsonObject,
): Promise<string | undefined> {
  if (entry.bindingId !== undefined)
    return typeof entry.bindingId === 'string' && entry.bindingId.length
      ? entry.bindingId
      : undefined;
  const match = typeof entry.key === 'string' && callKey.exec(entry.key);
  if (!match) return undefined;
  try {
    let call = await context.facts.read('calls', match[1]);
    const seen = new Set<string>();
    while (
      call.callId === match[1] &&
      call.experimentId === context.experimentId
    ) {
      const prior = call.recoveredFrom;
      if ((prior ?? call.callId) === entry.key)
        return typeof call.bindingId === 'string' && call.bindingId.length
          ? call.bindingId
          : undefined;
      if (
        typeof prior !== 'string' ||
        callKey.exec(prior)?.[1] !== match[1] ||
        seen.has(prior)
      )
        break;
      seen.add(prior);
      call = await context.facts.read('call-attempts', prior);
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

function shortReceiptKey(key: string): string {
  const match = callKey.exec(key);
  if (!match) return key.length > 20 ? `${key.slice(0, 17)}...` : key;
  return match[1].slice(0, 13);
}

export async function cleanupEvaluatorBinding(
  context: BindingCleanupContext,
  kind: EvaluatorCleanupSource['kind'],
  runtime?: RuntimeContext,
): Promise<CleanupResult[]> {
  return runEvaluatorCleanup(
    runtime?.reportProgress
      ? {
          ...context,
          reportProgress: (update) => runtime.reportProgress?.(update),
        }
      : context,
    {
      binding: { id: context.bindingId, kind },
      dryRun: context.dryRun,
    },
  );
}

export async function runEvaluatorCleanup(
  context: CleanupContext,
  { binding, dryRun = false }: CleanupRequest,
  run: (options: CleanupOptions) => Promise<unknown> = (options) =>
    new Evaluator().cleanup(options),
): Promise<CleanupResult[]> {
  const action = dryRun ? 'previewing' : 'cleaning';
  const reportProgress = (detail: string): void => {
    try {
      context.reportProgress?.({ detail });
    } catch {
      // Reporting is best effort.
    }
  };
  let receiptIndex = 0;
  const results: CleanupResult[] = [];
  for await (const { kind, entry } of cleanupReceipts(context)) {
    if (
      entry.status !== 'pending' ||
      entry.experimentId !== context.experimentId ||
      entry.kind !== binding.kind
    )
      continue;
    const bindingId = await recordedBinding(context, entry);
    const key = string(entry.key);
    if (!bindingId) {
      results.push({
        key,
        status: 'pending',
        error: 'Cannot identify the binding that owns the Evaluator input',
      });
      continue;
    }
    if (bindingId !== binding.id) continue;
    receiptIndex += 1;
    const label = `receipt #${receiptIndex}`;
    const shortKey = shortReceiptKey(key);
    reportProgress(`${action} ${label} (${shortKey})`);
    let outcome: CleanupOutcome;
    try {
      context.signal.throwIfAborted();
      const path = configPath(context, key, entry.kind);
      if (!path) throw new Error('Invalid Evaluator cleanup call identity');
      if (digest(await readFile(path, 'utf8')) !== entry.inputDigest)
        throw new Error('Evaluator input changed after the recorded call');
      // The SDK creates missing defaults during implicit network configuration lookup.
      const networkConfigPath = evaluatorNetworkConfigPath();
      const loaded = await loadConfig(path, {}, process.env, {
        allowMissingAuth: true,
        networkConfigPath,
      });
      if (cleanupTarget(loaded, process.env) !== entry.targetDigest)
        throw new Error(
          'The resolved Evaluator configuration or inventory location changed since the recorded call',
        );
      const { experiment } = loaded;
      // These absolute paths participate in the SDK ownership fingerprint. A
      // custom/shared bundle cannot establish exclusive ownership for this experiment.
      const scope =
        entry.kind === 'kernel'
          ? experiment.benchmark.config.manifest
          : experiment.solver.config.path;
      if (
        typeof scope !== 'string' ||
        !isAbsolute(scope) ||
        scope !== entry.ownerPath
      )
        throw new Error(
          'Exclusive ownership of the Evaluator input could not be established',
        );
      if (loaded.deployment) {
        reportProgress(`${action} ${label} (${shortKey} · Ray)`);
      }
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(600_000),
      ]);
      outcome = cleanupResult(
        await run({
          configPath: path,
          networkConfigPath,
          execute: !dryRun,
          signal,
        }),
        dryRun,
      );
      if (signal.aborted)
        outcome = {
          ...outcome,
          status: 'pending',
          error: errorText(signal.reason),
        };
    } catch (error) {
      outcome = { status: 'pending', error: errorText(error) };
    }
    if (!dryRun) {
      if (!Array.isArray(entry.attempts))
        throw new Error('Invalid Evaluator cleanup receipt');
      await context.facts.write(kind, key, {
        ...entry,
        bindingId,
        status: outcome.status,
        attempts: [
          ...entry.attempts,
          { at: new Date().toISOString(), ...outcome },
        ],
      });
    }
    results.push({ key, ...outcome });
    if (context.signal.aborted) break;
  }
  return results;
}
