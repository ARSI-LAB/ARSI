#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${label} must be a nonempty string`);
  return value;
}
function inside(directory, path) {
  const local = relative(directory, resolve(path));
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
    throw new Error(`Resource path escapes the example directory: ${path}`);
  return local;
}
async function filesIn(directory) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error(`Expected an ordinary directory: ${directory}`);
  const files = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile())
        files.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: sha256(await readFile(path)),
          mode: stat.mode & 0o777,
        });
      else
        throw new Error(
          `Only ordinary files are supported; no symlinks: ${path}`,
        );
    }
  }
  await visit(directory);
  return files;
}
function gitProvenance(directory) {
  function git(args) {
    const result = spawnSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout.trimEnd() : null;
  }
  const revision = git(['rev-parse', 'HEAD']);
  if (!revision) return null;
  const diff = git(['diff', '--binary', 'HEAD']);
  return {
    revision,
    status: git(['status', '--porcelain=v1', '--untracked-files=all']),
    trackedDiffSha256: diff === null ? null : sha256(diff),
  };
}
async function sdkIdentity(name) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
  let directory = dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (manifest.name === name) break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot find package identity for ${name}`);
    directory = parent;
  }
  const files = [];
  for (const resource of ['package.json', 'pnpm-lock.yaml', 'src', 'dist']) {
    const path = join(directory, resource);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const file of await filesIn(path))
        files.push({ ...file, path: `${resource}/${file.path}` });
    } else if (stat.isFile()) {
      files.push({
        path: resource,
        sha256: sha256(await readFile(path)),
        mode: stat.mode & 0o777,
      });
    } else throw new Error(`SDK identity requires ordinary files: ${path}`);
  }
  return {
    identity: { name, entry: relative(directory, entry), files },
    provenance: { name, directory, repository: gitProvenance(directory) },
  };
}
async function buildIdentity(buildDirectory, entryScriptPath) {
  if (!(await lstat(join(buildDirectory, 'src/index.js'))).isFile())
    throw new Error('Build the package before running the operator experiment');
  const sdks = await Promise.all([
    sdkIdentity('agent-bundle-core'),
    sdkIdentity('ember-evaluator'),
  ]);
  const identity = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    runtimeFiles: await filesIn(buildDirectory),
    scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    ...(entryScriptPath
      ? { entryScriptSha256: sha256(await readFile(entryScriptPath)) }
      : {}),
    packageSha256: sha256(
      await readFile(join(packageDirectory, 'package.json')),
    ),
    lockSha256: sha256(
      await readFile(join(packageDirectory, 'pnpm-lock.yaml')),
    ),
    sdks: sdks.map((sdk) => sdk.identity),
  };
  return {
    digest: sha256(JSON.stringify(identity)),
    identity,
    provenance: {
      directory: await realpath(buildDirectory),
      repository: gitProvenance(packageDirectory),
      sdks: sdks.map((sdk) => sdk.provenance),
    },
  };
}
export async function operatorBuildIdentity() {
  return buildIdentity(join(packageDirectory, 'dist'));
}
/** Validate guard estimates against the owners that enforce the real limits. */
export function validateOperatorSearchBudgets(recipe) {
  const policy = record(recipe.policy, 'Search Policy');
  const config = record(policy.config, 'Search Policy config');
  if (config.metricsEnabled !== true) return;
  const bindings = record(recipe.bindings, 'bindings');
  const sdk = record(
    record(record(bindings.evaluator, 'evaluator').config, 'evaluator.config')
      .sdk,
    'SDK',
  );
  const proposer = record(
    record(bindings.proposer, 'proposer').config,
    'proposer.config',
  );
  const embedding = record(proposer.embedding, 'embedding');
  const owners = {
    evaluationTimeoutMs: (sdk.timeoutSeconds + 30) * 1000,
    modelRequestTimeoutMs: proposer.modelRequestTimeoutMs ?? 120000,
    retrievalTimeoutMs: embedding.timeoutMs ?? 300000,
    cleanupReserveMs: record(recipe.budget, 'budget').cleanupReserveMs,
  };
  for (const [field, bound] of Object.entries(owners)) {
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new Error(`Invalid timeout/reserve owner for ${field}`);
    if (config[field] !== undefined && config[field] < bound)
      throw new Error(
        `Policy ${field} underestimates its owner timeout/reserve (${bound})`,
      );
    config[field] ??= bound;
  }
}

async function copiedRecipe(
  recipePath,
  sourceDirectory,
  inputsDirectory,
  options,
) {
  const document = parseDocument(await readFile(recipePath, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length) throw document.errors[0];
  const recipe = record(document.toJS({ maxAliasCount: 0 }), 'Recipe');
  if (recipe.schemaVersion !== 'rsi.recipe/v1')
    throw new Error('Expected rsi.recipe/v1');
  const search = options.kind === 'search';
  if (search) validateOperatorSearchBudgets(recipe);
  const diagnostic =
    !search && recipe.policy?.id === 'policy.operator-diagnostic';
  const label = search ? 'Operator search' : 'SDK baseline';
  const application = record(recipe.application, 'application');
  const policy = record(recipe.policy, 'policy');
  if (
    application.plugin !== 'application.kernel' ||
    policy.id !==
      (search
        ? 'policy.operator-search'
        : diagnostic
          ? 'policy.operator-diagnostic'
          : 'policy.operator-baseline') ||
    recipe.reflection !== undefined
  )
    throw new Error(
      `${label} requires application.kernel, its matching Policy and no Reflection`,
    );
  const bindings = record(recipe.bindings, 'bindings');
  const expected = {
    ...(search ? { agent: 'agent.pi', proposer: 'proposer.operator' } : {}),
    evaluator: 'evaluator.operatorbench',
    selector: 'selector.metric',
  };
  if (!same(Object.keys(bindings).sort(), Object.keys(expected).sort()))
    throw new Error(
      `${label} requires exactly ${Object.keys(expected).join(', ')} bindings`,
    );
  for (const [name, ref] of Object.entries(expected)) {
    const binding = record(bindings[name], `bindings.${name}`);
    if (binding.plugin !== ref || binding.bindings !== undefined)
      throw new Error(
        `${label} requires ${name} binding ${ref} without nested bindings`,
      );
    binding.config = record(binding.config ?? {}, `bindings.${name}.config`);
  }
  async function localResource(value, kind, label) {
    const path = resolve(sourceDirectory, text(value, label));
    const local = inside(sourceDirectory, path);
    const destination = join(inputsDirectory, local);
    const stat = await lstat(destination);
    if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile()))
      throw new Error(`${label} must reference an ordinary ${kind}`);
    return destination;
  }
  const applicationConfig = record(application.config, 'application.config');
  const baseline = record(
    applicationConfig.baseline,
    'application.config.baseline',
  );
  baseline.directory = await localResource(
    baseline.directory,
    'directory',
    'baseline.directory',
  );
  const target = record(applicationConfig.target, 'application.config.target');
  target.schema = await localResource(target.schema, 'file', 'target.schema');
  const evaluator = bindings.evaluator.config;
  if (
    evaluator.mode !== 'sdk' ||
    (options.mode !== undefined && options.mode !== 'sdk')
  )
    throw new Error('Operator entry requires SDK evaluation');
  if (evaluator.fixtures !== undefined)
    throw new Error('SDK mode rejects evaluation fixtures');
  if (
    !search &&
    (recipe.budget?.evaluationRuns !== 2 || recipe.budget?.modelCalls !== 0)
  )
    throw new Error('SDK baseline requires evaluationRuns 2 and modelCalls 0');
  const sdk = record(evaluator.sdk, 'evaluator.sdk');
  sdk.python = text(options.sdk?.python, 'SDK Python interpreter');
  sdk.device = options.sdk?.device;
  if (!Number.isSafeInteger(sdk.device) || sdk.device < 0)
    throw new Error('SDK device must be a nonnegative integer');
  sdk.profiling = {
    ...record(sdk.profiling, 'profiling'),
    enabled: options.sdk?.profiling === true,
    ...(options.sdk?.msprofBin === undefined
      ? {}
      : { msprofBin: text(options.sdk.msprofBin, 'SDK msprofBin') }),
  };
  if (options.sdk?.protocol !== undefined) {
    const protocol = record(options.sdk.protocol, 'SDK timing protocol');
    if (
      !(
        (protocol.warmup === 5 && protocol.repeat === 20) ||
        (protocol.warmup === 10 && protocol.repeat === 100)
      )
    )
      throw new Error('Calibration supports only 5/20 or 10/100');
    evaluator.protocol = {
      ...record(evaluator.protocol, 'evaluator.protocol'),
      ...protocol,
    };
  }
  const required =
    2 * (sdk.timeoutSeconds + 30) * 1000 + recipe.budget.cleanupReserveMs;
  if (
    !search &&
    (!Number.isFinite(required) || recipe.budget.elapsedWallMs <= required)
  )
    throw new Error(
      'SDK total budget must cover two calls, preparation and cleanup',
    );
  const task = record(evaluator.task, 'evaluator.task');
  task.directory = await localResource(
    task.directory,
    'directory',
    'evaluator.task.directory',
  );
  if (search) {
    if (options.sdk?.profiling !== false)
      throw new Error('Search requires profiling false');
    const metrics =
      record(policy.config, 'Search Policy config').metricsEnabled === true;
    const limits = {
      evaluationRuns: metrics ? 65 : 14,
      modelCalls: metrics ? 152 : 32,
      operations: metrics ? 1024 : 256,
      elapsedWallMs: metrics ? 7200000 : 2400000,
      cleanupReserveMs: 60000,
    };
    const budget = record(recipe.budget, 'Search budget');
    for (const [name, maximum] of Object.entries(limits))
      if (
        !Number.isSafeInteger(budget[name]) ||
        budget[name] < (name === 'modelCalls' ? 0 : 1) ||
        budget[name] > maximum
      )
        throw new Error(`Search budget.${name} must not exceed ${maximum}`);
    if (budget.cleanupReserveMs !== 60000)
      throw new Error('Search requires cleanupReserveMs 60000');
    const config = record(policy.config, 'Search Policy config');
    if (options.maxRounds !== undefined) config.maxRounds = options.maxRounds;
    for (const [name, minimum] of [
      ['maxAttempts', 1],
      ['repairLimit', 0],
    ])
      if (
        !Number.isSafeInteger(config[name] ?? 3) ||
        (config[name] ?? 3) < minimum ||
        (config[name] ?? 3) > 3
      )
        throw new Error(`Search Policy ${name} must not exceed 3`);
    const selector = bindings.selector.config;
    if (
      selector.metric !== 'latencyMeanMs' ||
      selector.direction !== 'minimize' ||
      !Array.isArray(selector.eligibility) ||
      !selector.eligibility.some(
        (rule) => rule.metric === 'candidateValid' && rule.min === 1,
      )
    )
      throw new Error(
        'Search Selector requires latencyMeanMs/minimize and candidateValid >= 1',
      );
    const agent = bindings.agent.config;
    if (agent.retries !== undefined && agent.retries !== 0)
      throw new Error('Search Agent requires retries 0');
    agent.retries = 0;
    if (
      agent.api_key !== undefined &&
      (typeof agent.api_key !== 'string' ||
        !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(agent.api_key))
    )
      throw new Error(
        'Search Agent api_key must be an environment placeholder',
      );
    const proposer = bindings.proposer.config;
    if ((proposer.agentRef ?? 'agent') !== 'agent')
      throw new Error('Search proposer.agentRef must be agent');
    proposer.agentRef = 'agent';
    const proposerTask = record(proposer.task, 'proposer.task');
    proposerTask.directory = await localResource(
      proposerTask.directory,
      'directory',
      'proposer.task.directory',
    );
    if (proposerTask.directory !== task.directory)
      throw new Error('Proposer and Evaluator task directories must match');
    if (proposer.hardwareContextFile !== undefined) {
      const sourcePath = resolve(
        sourceDirectory,
        text(proposer.hardwareContextFile, 'proposer.hardwareContextFile'),
      );
      const local = relative(sourceDirectory, sourcePath);
      // Files inside the example were copied and integrity checked already.
      const source =
        !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
          ? join(inputsDirectory, local)
          : sourcePath;
      let bytes;
      try {
        const stat = await lstat(source);
        if (!stat.isFile())
          throw new Error('expected an ordinary file without symlinks');
        if ((stat.mode & 0o444) === 0) throw new Error('file is not readable');
        bytes = await readFile(source);
      } catch (error) {
        throw new Error(
          `hardwareContextFile could not be read: ${error.message}`,
          { cause: error },
        );
      }
      let content;
      try {
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch (error) {
        throw new Error('hardwareContextFile must contain valid UTF-8 text', {
          cause: error,
        });
      }
      if (content.trim() === '')
        throw new Error('hardwareContextFile must not be empty');
      const directory = join(inputsDirectory, '_operator-search');
      await mkdir(directory, { recursive: true });
      const frozenPath = join(directory, 'hardware-context.md');
      await writeFile(frozenPath, bytes, { flag: 'wx' });
      await writeFile(
        join(directory, 'hardware-context.json'),
        JSON.stringify(
          {
            schemaVersion: 'rsi.operator-hardware-context/v1',
            file: 'hardware-context.md',
            sha256: sha256(bytes),
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      proposer.hardwareContextFile = frozenPath;
    }
    const embedding = record(proposer.embedding, 'proposer.embedding');
    const supplied = record(options.embedding, 'Embedding parameters');
    embedding.python = text(supplied.python, 'Embedding Python interpreter');
    embedding.modelDirectory = resolve(
      text(supplied.modelDirectory, 'Embedding modelDirectory'),
    );
    embedding.identityFile = join(
      inputsDirectory,
      '_operator-search',
      'embedding-identity.json',
    );
    embedding.device = 'cpu';
    if (options.minRelativeImprovement !== undefined)
      bindings.selector.config.minRelativeImprovement =
        options.minRelativeImprovement;
  }
  return recipe;
}

async function executionParameters(options) {
  if (options.kind !== 'search') return options.sdk ?? null;
  const embedding = record(options.embedding, 'Embedding parameters');
  const identityFile = resolve(
    text(embedding.identityFile, 'Embedding identityFile'),
  );
  return {
    sdk: options.sdk,
    embedding: {
      python: text(embedding.python, 'Embedding Python interpreter'),
      modelDirectory: resolve(
        text(embedding.modelDirectory, 'Embedding modelDirectory'),
      ),
      identityFile,
      identitySha256: sha256(await readFile(identityFile)),
    },
    maxRounds: options.maxRounds ?? null,
    calibration: options.calibration ?? null,
    minRelativeImprovement: options.minRelativeImprovement ?? null,
  };
}

/** Verify archived inputs without consulting the live build or running an experiment. */
export async function inspectOperatorInputs(manifestPath) {
  const manifest = record(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    'Snapshot manifest',
  );
  if (
    manifest.schemaVersion !== 'rsi.operator-inputs/v2' ||
    manifest.mode !== 'sdk'
  )
    throw new Error('Expected an SDK input snapshot');
  const inputs = join(dirname(manifestPath), 'inputs');
  if (!same(await filesIn(inputs), manifest.files))
    throw new Error('Snapshot integrity mismatch');
  if (sha256(JSON.stringify(manifest.build.identity)) !== manifest.build.digest)
    throw new Error('Snapshot build identity mismatch');
  const recipePath = resolve(inputs, text(manifest.recipe, 'Snapshot Recipe'));
  inside(inputs, recipePath);
  const parameters = record(
    manifest.executionParameters,
    'Execution parameters',
  );
  return {
    recipePath,
    identity: sha256(
      JSON.stringify({
        build: manifest.build.digest,
        recipe: manifest.recipe,
        source: manifest.source.files,
        ...(manifest.kind === 'search'
          ? {
              parameters,
              ...(manifest.hardwareContext === undefined
                ? {}
                : { hardwareContext: manifest.hardwareContext }),
            }
          : { python: parameters.python, device: parameters.device }),
      }),
    ),
  };
}

/** Freeze explicit SDK baseline inputs without changing normal Recipe loading. */
export async function prepareOperatorInputs(
  recipePath,
  rootDirectory,
  id,
  options = {},
) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Error(`Unsafe experiment identifier: ${id}`);
  const buildDirectory = resolve(
    options.buildDirectory ?? join(packageDirectory, 'dist'),
  );
  if (options.kind !== undefined && options.kind !== 'search')
    throw new Error('Unknown operator input kind');
  const parameters = await executionParameters(options);
  const runDirectory = resolve(
    rootDirectory,
    options.kind === 'search' ? '.rsi/operator-search' : '.rsi/operator-sdk',
    id,
  );
  const inputsDirectory = join(runDirectory, 'inputs');
  const manifestPath = join(runDirectory, 'manifest.json');
  const build = await buildIdentity(buildDirectory, options.entryScriptPath);
  if (options.resume) {
    const manifest = record(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      'Snapshot manifest',
    );
    if (
      manifest.schemaVersion !== 'rsi.operator-inputs/v2' ||
      manifest.id !== id
    )
      throw new Error('Snapshot manifest identity mismatch');
    if (
      manifest.mode !== 'sdk' ||
      manifest.kind !== options.kind ||
      !same(manifest.executionParameters ?? null, parameters)
    )
      throw new Error(
        'Snapshot execution parameters changed; start a new experiment',
      );
    if (!same(await filesIn(inputsDirectory), manifest.files))
      throw new Error('Snapshot integrity mismatch: copied inputs changed');
    if (record(manifest.build, 'Snapshot build').digest !== build.digest)
      throw new Error('Running build identity changed; start a new experiment');
    const preparedRecipe = resolve(
      inputsDirectory,
      text(manifest.recipe, 'Snapshot Recipe'),
    );
    inside(inputsDirectory, preparedRecipe);
    return {
      recipePath: preparedRecipe,
      manifestPath,
      runtimeDirectory: join(inputsDirectory, 'runtime'),
    };
  }
  const sourceRecipe = resolve(recipePath);
  const sourceDirectory = dirname(sourceRecipe);
  if (!relative(sourceDirectory, runDirectory).startsWith(`..${sep}`))
    throw new Error(
      'Snapshot directory must be outside the source example folder',
    );
  if (options.kind === 'search') {
    const model = await realpath(parameters.embedding.modelDirectory);
    const local = relative(await realpath(sourceDirectory), model);
    if (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
      throw new Error(
        'Embedding model weights must be outside the source example directory',
      );
  }
  const sourceFiles = await filesIn(sourceDirectory);
  const source = {
    directory: sourceDirectory,
    recipePath: sourceRecipe,
    repository: gitProvenance(sourceDirectory),
    files: sourceFiles,
  };
  await mkdir(dirname(runDirectory), { recursive: true });
  try {
    await mkdir(runDirectory);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`Operator snapshot ${id} already exists; use --resume`);
    throw error;
  }
  try {
    await mkdir(inputsDirectory);
    for (const file of sourceFiles) {
      const bytes = await readFile(join(sourceDirectory, file.path));
      if (sha256(bytes) !== file.sha256)
        throw new Error('Source inputs changed while preparing the snapshot');
      const destination = join(inputsDirectory, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx', mode: file.mode });
      await chmod(destination, file.mode);
    }
    const recipeName = basename(sourceRecipe);
    const recipe = await copiedRecipe(
      join(inputsDirectory, recipeName),
      sourceDirectory,
      inputsDirectory,
      options,
    );
    await writeFile(join(inputsDirectory, recipeName), stringify(recipe));
    if (options.kind === 'search') {
      const directory = join(inputsDirectory, '_operator-search');
      await mkdir(directory, { recursive: true });
      const bytes = await readFile(parameters.embedding.identityFile);
      if (sha256(bytes) !== parameters.embedding.identitySha256)
        throw new Error('Embedding identity changed while preparing snapshot');
      await writeFile(join(directory, 'embedding-identity.json'), bytes, {
        flag: 'wx',
      });
      await writeFile(
        join(directory, 'calibration-proof.json'),
        JSON.stringify(options.calibration ?? null, null, 2) + '\n',
        { flag: 'wx' },
      );
    }
    {
      for (const file of build.identity.runtimeFiles) {
        const bytes = await readFile(join(buildDirectory, file.path));
        if (sha256(bytes) !== file.sha256)
          throw new Error('Runtime changed while copying SDK inputs');
        const target = join(inputsDirectory, 'runtime', file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx', mode: file.mode });
        await chmod(target, file.mode);
      }
    }
    if (!same(await filesIn(sourceDirectory), sourceFiles))
      throw new Error('Source inputs changed while preparing the snapshot');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 'rsi.operator-inputs/v2',
          id,
          mode: 'sdk',
          ...(options.kind ? { kind: options.kind } : {}),
          executionParameters: parameters,
          ...(options.kind === 'search' &&
          recipe.bindings.proposer.config.hardwareContextFile !== undefined
            ? {
                hardwareContext: JSON.parse(
                  await readFile(
                    join(
                      inputsDirectory,
                      '_operator-search/hardware-context.json',
                    ),
                    'utf8',
                  ),
                ),
              }
            : {}),
          recipe: recipeName,
          source,
          build,
          files: await filesIn(inputsDirectory),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    return {
      recipePath: join(inputsDirectory, recipeName),
      manifestPath,
      runtimeDirectory: join(inputsDirectory, 'runtime'),
    };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function measurementSummary(manager, ref) {
  if (typeof ref !== 'string') return null;
  const measurement = await manager.facts.read('measurements', ref);
  const items = record(
    await manager.artifacts.readJson(measurement.itemsRef),
    'Measurement items',
  );
  const diagnostics = [];
  for (const item of items.items) {
    if (!item.evaluation) continue;
    const feedback = record(
      await manager.artifacts.readJson(item.evaluation.artifactRef),
      'Evaluation feedback',
    );
    diagnostics.push(...feedback.diagnostics);
  }
  return {
    measurementRef: ref,
    candidateRef: measurement.candidateRef,
    comparisonKey: measurement.comparisonKey,
    status: measurement.status,
    coverage: measurement.coverage,
    metrics: measurement.metrics,
    diagnosticsRef: measurement.diagnosticsRef,
    evidenceIndexRef: measurement.evidenceIndexRef,
    conditions: await manager.artifacts.readJson(
      measurement.conditions.artifactRef,
    ),
    provenance: await manager.artifacts.readJson(
      measurement.provenance.artifactRef,
    ),
    diagnostics,
    profile: measurement.profile
      ? await manager.artifacts.readJson(measurement.profile.artifactRef)
      : null,
  };
}

// Restore confirmed search progress without treating an unfinished call as a decision.
function confirmedPolicyProgress(calls) {
  const at = (path, bindingId) =>
    calls.find((call) => call.path === path && call.bindingId === bindingId);
  const successful = (call) => call?.status === 'succeeded';
  const baseline = at('steps/check_baseline', 'selector');
  const finalEvaluation = at('steps/evaluate_final', 'evaluator');
  const finalSelection = at('steps/check_final', 'selector');
  if (!baseline && !finalEvaluation) return null;
  let bestCandidateRef = successful(baseline)
    ? baseline.output.selectedCandidateRef
    : null;
  let bestMeasurementRef = successful(baseline)
    ? baseline.output.measurementRef
    : null;
  const selections = calls.filter(
    (call) =>
      successful(call) &&
      call.bindingId === 'selector' &&
      call.pluginId === 'selector.metric' &&
      call.path !== 'steps/check_baseline' &&
      call.path !== 'steps/check_final',
  );
  const visited = new Set();
  for (;;) {
    const promotion = selections.find(
      (call) =>
        call.output.accepted === true &&
        call.input.incumbentMeasurementRef === bestMeasurementRef &&
        !visited.has(call),
    );
    if (!promotion) break;
    visited.add(promotion);
    bestCandidateRef = promotion.output.selectedCandidateRef;
    bestMeasurementRef = promotion.output.measurementRef;
  }
  const actions = calls
    .filter(
      (call) =>
        successful(call) &&
        call.pluginId === 'proposer.operator' &&
        ['static', 'metrics'].includes(call.input.phase),
    )
    .sort(
      (a, b) =>
        Number(a.input.phase === 'metrics') -
          Number(b.input.phase === 'metrics') ||
        (a.input.round ?? a.input.attempt) -
          (b.input.round ?? b.input.attempt) ||
        (a.input.repairIndex ?? 0) - (b.input.repairIndex ?? 0),
    );
  const sameAttempt = (a, b) =>
    a.phase === b.phase && (a.round ?? a.attempt) === (b.round ?? b.attempt);
  const proposals = actions.filter(
    (call) =>
      call.input.action === 'propose' &&
      call.output.reasonCode !== 'no-static-issues',
  );
  const summaries = actions.filter((call) => call.input.action === 'summarize');
  const attemptActions = (input) =>
    actions.filter((call) => sameAttempt(call.input, input));
  const repairCount = (input) =>
    Math.max(
      0,
      ...attemptActions(input).map((call) => call.input.repairIndex ?? 0),
    );
  const completed = summaries.map((call) => ({
    ...(call.input.phase === 'metrics'
      ? {
          round: call.input.round,
          parentCandidateRef: call.input.parentCandidateRef,
          diagnosticMeasurementRef:
            proposals.find((proposal) =>
              sameAttempt(proposal.input, call.input),
            )?.input.diagnosticMeasurementRef ?? null,
          candidateDiagnosticMeasurementRef:
            call.input.candidateDiagnosticMeasurementRef,
        }
      : { attempt: call.input.attempt }),
    candidateRefs: call.input.candidateRefs,
    measurementRefs: call.input.measurementRefs,
    decisionRef: call.input.decisionRef,
    summaryRef: call.output.summaryRef,
    historyRef: call.output.historyRef,
    outcome: call.input.outcome,
    accepted: call.input.outcome === 'adopted',
    repairCount: repairCount(call.input),
  }));
  const incompleteAttempts = proposals
    .filter(
      (proposal) =>
        !summaries.some((summary) =>
          sameAttempt(summary.input, proposal.input),
        ),
    )
    .map((proposal) => {
      const input = proposal.input;
      const scope =
        proposal.path.slice(0, proposal.path.lastIndexOf('/')) + '/';
      const related = selections.filter((call) => call.path.startsWith(scope));
      const created = attemptActions(input).filter(
        (call) => call.output.status === 'created',
      );
      const measurementRefs = created.flatMap((call) => {
        const evaluation = calls.find(
          (evaluation) =>
            successful(evaluation) &&
            evaluation.path.startsWith(scope) &&
            evaluation.pluginId === 'evaluator.operatorbench' &&
            evaluation.input.action === 'evaluate' &&
            evaluation.input.candidateRef === call.output.candidateRef,
        );
        return evaluation ? [evaluation.output.measurementRef] : [];
      });
      const selection = related.find(
        (call) => call.input.candidateMeasurementRef === measurementRefs.at(-1),
      );
      return {
        phase: input.phase,
        ...(input.phase === 'metrics'
          ? { round: input.round }
          : { attempt: input.attempt }),
        candidateRef:
          created.at(-1)?.output.candidateRef ?? proposal.output.candidateRef,
        candidateRefs: created.map((call) => call.output.candidateRef),
        measurementRef: measurementRefs.at(-1) ?? null,
        measurementRefs,
        decisionRef: selection?.output.decisionRef ?? null,
        accepted: selection?.output.accepted === true,
        repairCount: repairCount(input),
      };
    });
  const staticSummaries = summaries.filter(
    (call) => call.input.phase === 'static',
  );
  const metricSummaries = summaries.filter(
    (call) => call.input.phase === 'metrics',
  );
  const diagnostics = calls.filter(
    (call) =>
      successful(call) &&
      call.pluginId === 'evaluator.operatorbench' &&
      call.input.action === 'profile',
  );
  return {
    bestCandidateRef,
    bestMeasurementRef,
    finalMeasurementRef: successful(finalEvaluation)
      ? finalEvaluation.output.measurementRef
      : (finalEvaluation?.measurementRef ?? null),
    finalDecisionRef: successful(finalSelection)
      ? finalSelection.output.decisionRef
      : null,
    finalValidity: successful(finalSelection)
      ? finalSelection.output.candidateFeasible
        ? 'valid'
        : 'invalid'
      : null,
    finalAssessmentStatus: finalEvaluation?.status ?? 'not-recorded',
    analysisRef:
      actions.filter((call) => call.input.action !== 'summarize').at(-1)?.output
        .analysisRef ?? null,
    historyRef:
      (metricSummaries.at(-1) ?? staticSummaries.at(-1))?.output.historyRef ??
      null,
    staticHistoryRef: staticSummaries.at(-1)?.output.historyRef ?? null,
    phase:
      actions.some((call) => call.input.phase === 'metrics') ||
      diagnostics.length
        ? 'metrics'
        : actions.length
          ? 'static'
          : null,
    attempts: completed.filter((entry) => entry.attempt !== undefined),
    metricsRounds: completed.filter((entry) => entry.round !== undefined),
    diagnosticRefs: diagnostics.map((call) => call.output.measurementRef),
    incompleteAttempts,
    stopReason: null,
  };
}

export async function summarizeOperatorExperiment(manager, id, manifestPath) {
  const experiment = await manager.get(id);
  const owned = (values) => values.filter((value) => value.experimentId === id);
  const calls = owned(await manager.facts.list('calls'));
  const recovered = confirmedPolicyProgress(calls);
  const output = experiment.output ?? recovered;
  const attempts = [];
  if (output) {
    for (const attempt of output.attempts)
      attempts.push({
        ...attempt,
        measurement: await measurementSummary(manager, attempt.measurementRef),
        ...(Array.isArray(attempt.measurementRefs)
          ? {
              measurements: await Promise.all(
                attempt.measurementRefs.map((ref) =>
                  measurementSummary(manager, ref),
                ),
              ),
            }
          : {}),
        decision:
          typeof attempt.decisionRef === 'string'
            ? await manager.artifacts.readJson(attempt.decisionRef)
            : null,
      });
  }
  const incompleteAttempts = [];
  for (const attempt of recovered?.incompleteAttempts ?? [])
    incompleteAttempts.push({
      ...attempt,
      measurement: await measurementSummary(manager, attempt.measurementRef),
    });
  const finalMeasurement = await measurementSummary(
    manager,
    output?.finalMeasurementRef,
  );
  let finalValidity = output?.finalValidity ?? null;
  if (finalValidity === null && finalMeasurement?.status === 'succeeded') {
    const validity = finalMeasurement.metrics.candidateValid;
    if (validity?.status === 'available' && validity.value.kind === 'scalar') {
      if (validity.value.value === 1) finalValidity = 'valid';
      else if (validity.value.value === 0) finalValidity = 'invalid';
    }
  }
  let bestSource = null;
  if (output?.bestCandidateRef) {
    const candidate = await manager.facts.read(
      'candidates',
      output.bestCandidateRef,
    );
    const tree = record(
      await manager.artifacts.readJson(candidate.artifactRef),
      'Best source tree',
    );
    const file = tree.files.find((entry) => entry.path === 'input.py');
    if (!file)
      throw new Error('Best source artifact does not contain input.py');
    const bytes = Buffer.from(file.base64, 'base64');
    const sourcePath = join(dirname(manifestPath), 'best-input.py');
    await writeFile(sourcePath, bytes);
    const diffRefs = [];
    const entryRef = experiment.application.initialCandidateRef;
    let cursor = candidate;
    while (cursor.ref !== entryRef) {
      const receipt = calls.find(
        (call) =>
          call.pluginId === 'proposer.operator' &&
          call.status === 'succeeded' &&
          call.output.status === 'created' &&
          call.output.candidateRef === cursor.ref &&
          (call.input.action === 'propose'
            ? call.input.phase === 'metrics'
              ? call.input.parentCandidateRef
              : call.input.entryCandidateRef
            : call.input.action === 'repair'
              ? call.input.failedCandidateRef
              : null) === cursor.parentRef,
      );
      if (
        !receipt ||
        typeof receipt.output.diffRef !== 'string' ||
        !cursor.parentRef
      )
        throw new Error(
          'Best source ancestry lacks a successful Proposer diff receipt',
        );
      diffRefs.unshift(receipt.output.diffRef);
      cursor = await manager.facts.read('candidates', cursor.parentRef);
    }
    bestSource = {
      candidateRef: output.bestCandidateRef,
      artifactRef: candidate.artifactRef,
      sha256: sha256(bytes),
      path: sourcePath,
      diffRefs,
    };
  }
  const recordedMeasurements = await Promise.all(
    owned(await manager.facts.list('measurements')).map((measurement) =>
      measurementSummary(manager, measurement.ref),
    ),
  );
  return {
    id,
    mode: 'sdk',
    status: experiment.status,
    reportSource: experiment.output ? 'policy-output' : 'confirmed-receipts',
    error: experiment.error ?? null,
    manifestPath,
    usage: experiment.usage ?? null,
    stopReason: output?.stopReason ?? null,
    finalValidity,
    finalTimingStable: output?.finalTimingStable ?? null,
    analysisRef: output?.analysisRef ?? null,
    historyRef: output?.historyRef ?? null,
    staticHistoryRef: output?.staticHistoryRef ?? null,
    phase: output?.phase ?? null,
    metricsRounds: output?.metricsRounds ?? [],
    diagnosticRefs: output?.diagnosticRefs ?? [],
    diagnosticMeasurementRef: output?.diagnosticMeasurementRef ?? null,
    collectionStatus: output?.collectionStatus ?? null,
    sdkCalls: Object.fromEntries(
      ['evaluate', 'profile'].map((action) => [
        action,
        calls.filter(
          (call) =>
            call.pluginId === 'evaluator.operatorbench' &&
            (call.input.action ?? 'evaluate') === action,
        ).length,
      ]),
    ),
    finalAssessmentStatus: recovered?.finalAssessmentStatus ?? 'not-recorded',
    bestSource,
    baselineMeasurement: await measurementSummary(
      manager,
      calls.find(
        (call) =>
          call.path === 'steps/evaluate_baseline' &&
          call.status === 'succeeded',
      )?.output.measurementRef,
    ),
    bestMeasurement: await measurementSummary(
      manager,
      output?.bestMeasurementRef,
    ),
    finalMeasurement,
    finalDecisionRef: output?.finalDecisionRef ?? null,
    attempts: output ? attempts : null,
    incompleteAttempts,
    recordedMeasurements,
    cleanupRecords: owned(await manager.facts.list('cleanup')),
    unconfirmedOrFailedCalls: calls.filter(
      (call) => call.status !== 'succeeded',
    ),
    unreleasedInstances: owned(await manager.facts.list('instances')).filter(
      (instance) => instance.status !== 'released',
    ),
  };
}
