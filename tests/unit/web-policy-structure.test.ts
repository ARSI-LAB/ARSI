import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JsonObject } from '../../src/contracts/index.js';
import { createServer } from '../../src/entries/web/server.js';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
import { digest, object } from '../../src/shared/json.js';
import { parsePolicyStructure } from '../../web/api/observation-client.js';

const privateValue = 'snapshot-private-token';
const experimentId = 'policy-snapshot';
const endpoint = `/api/observation/experiments/${experimentId}/policy-structure`;

function savedDefinition(directory: string): JsonObject {
  const content: JsonObject = {
    schemaVersion: 'rsi.definition-lock/v1',
    recipe: {
      schemaVersion: 'rsi.recipe/v1',
      id: 'saved-recipe',
      application: { plugin: 'application.saved', config: {} },
      policy: { id: 'policy.saved', config: { rounds: 3 }, input: {} },
      bindings: {
        worker: {
          plugin: 'worker.saved',
          config: {
            apiKey: privateValue,
            prompt: join(directory, 'not-restored', 'prompt.md'),
            opaque:
              '${{ this is plugin configuration, not a Policy expression }}',
          },
        },
      },
      budget: {},
    },
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.saved',
      input_schema: { type: 'object' },
      config_schema: { type: 'object' },
      state_schema: { type: 'object' },
      output_schema: { type: 'object' },
      input: { candidate: '${{ application.initialCandidate }}' },
      state: { selected: '${{ input.candidate }}' },
      require: { worker: { contract: 'contract.saved' } },
      defaults: {
        bindings: {
          worker: { plugin: 'worker.default', config: { source: 'default' } },
        },
      },
      steps: [
        {
          id: privateValue,
          type: 'invoke',
          use: 'worker',
          with: {
            candidate: '${{ state.selected }}',
            note: `\${{ '${privateValue}' }}`,
            [privateValue]: 'A credential repeated as a declaration key',
          },
        },
      ],
      output: { result: `\${{ steps['${privateValue}'].output }}` },
    },
    recipeSourcePath: join(directory, 'recipe.yaml'),
    policySourcePath: join(directory, 'policy.yaml'),
    plugins: {},
    resources: [
      {
        directory: join(directory, 'not-restored'),
        artifactRef: `artifact:${'a'.repeat(64)}`,
      },
    ],
    resourceOrigins: { worker: { '/prompt': join(directory, 'prompt.md') } },
    reflection: null,
  };
  return { ...content, digest: digest(content) };
}

function relock(lock: JsonObject): JsonObject {
  const { digest: _previous, ...content } = lock;
  return { ...content, digest: digest(content) };
}

async function fixture(t: TestContext): Promise<{
  directory: string;
  facts: FileFacts;
  artifacts: FileArtifacts;
  server: Awaited<ReturnType<typeof createServer>>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-policy-structure-'));
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  await facts.write('experiments', experimentId, {
    id: experimentId,
    recipeId: 'saved-recipe',
    status: 'interrupted',
  });
  const server = await createServer({
    manager: {
      facts,
      artifacts,
      list: () => facts.list('experiments'),
      get: (id) => facts.read('experiments', id),
      reflection: () => {
        throw new Error('A structure read must not activate Reflection');
      },
      run: async () => {
        throw new Error(
          'A structure read must not run or resume an experiment',
        );
      },
      cancel: async () => {
        throw new Error('A structure read must not cancel an experiment');
      },
    },
    registry: {
      catalog: () => {
        throw new Error('A structure read must not load the current catalog');
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, facts, artifacts, server };
}

async function storedFiles(directory: string): Promise<string> {
  const files = (
    await readdir(directory, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return JSON.stringify(
    await Promise.all(
      files.map(async (path) => [path, await readFile(path, 'utf8')]),
    ),
  );
}

test('Policy structure HTTP reads only the saved definition and redacts all projected strings', async (t) => {
  const { directory, facts, artifacts, server } = await fixture(t);
  const lock = savedDefinition(directory);
  await facts.write('definitions', experimentId, lock);
  await writeFile(join(directory, 'policy.yaml'), 'initial source');
  await writeFile(join(directory, 'recipe.yaml'), 'initial recipe');
  const before = await storedFiles(directory);
  t.mock.method(facts, 'write', async () => {
    throw new Error('A structure read must not write facts');
  });
  for (const method of ['readJson', 'capture', 'materialize'] as const)
    t.mock.method(artifacts, method, async () => {
      throw new Error('A structure read must not read or restore resources');
    });

  const response = await server.inject(endpoint);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(!response.body.includes(privateValue), response.body);
  assert.match(response.body, /REDACTED/);
  const model = parsePolicyStructure(response.json());
  assert.deepEqual(model.source, {
    experimentId,
    policyId: 'policy.saved',
    definitionDigest: lock.digest,
    snapshot: 'initial',
  });
  assert.deepEqual(model.availability, {
    overall: 'complete',
    flow: 'complete',
    data: 'complete',
    details: 'complete',
  });
  assert.equal(model.steps.length, 1);
  assert.equal(
    model.bindings.find((entry) => entry.name === 'worker')?.plugin,
    'worker.saved',
  );
  assert.ok(response.body.includes('not-restored'));
  assert.equal(await storedFiles(directory), before);

  await writeFile(
    join(directory, 'policy.yaml'),
    'later incompatible local Policy',
  );
  await writeFile(
    join(directory, 'recipe.yaml'),
    'later incompatible local Recipe',
  );
  const afterSourceEdits = await storedFiles(directory);
  const reread = await server.inject(endpoint);
  assert.equal(reread.statusCode, 200, reread.body);
  assert.deepEqual(reread.json(), response.json());
  assert.equal(await storedFiles(directory), afterSourceEdits);
  await rm(join(directory, 'policy.yaml'));
  await rm(join(directory, 'recipe.yaml'));
  assert.deepEqual((await server.inject(endpoint)).json(), response.json());
});

test('Policy structure HTTP distinguishes missing, unsupported and corrupt snapshots without fallback', async (t) => {
  const { directory, facts, server } = await fixture(t);
  const missing = await server.inject(endpoint);
  assert.equal(missing.statusCode, 200, missing.body);
  const absent = parsePolicyStructure(missing.json());
  assert.equal(absent.availability.overall, 'unavailable');
  assert.equal(absent.diagnostics[0]?.category, 'missing-source');
  const original = savedDefinition(directory);
  const invalidPolicy = structuredClone(original);
  object(invalidPolicy.policy).schemaVersion = 'rsi.policy/future';
  const mismatchedPolicy = structuredClone(original);
  object(object(mismatchedPolicy.recipe).policy).id = 'policy.different';
  const invalidReflection = structuredClone(original);
  invalidReflection.reflection = { secret: privateValue };
  const missingOutput = structuredClone(original);
  delete object(missingOutput.policy).output;
  const variants: [JsonObject, string][] = [
    [
      relock({ ...original, schemaVersion: 'rsi.definition-lock/future' }),
      'unsupported-source',
    ],
    [{ ...original, digest: '0'.repeat(64) }, 'invalid-source'],
    [relock(invalidPolicy), 'unsupported-source'],
    [relock(mismatchedPolicy), 'invalid-source'],
    [relock(invalidReflection), 'invalid-source'],
    [relock(missingOutput), 'invalid-source'],
  ];
  for (const [lock, category] of variants) {
    await facts.write('definitions', experimentId, lock);
    const response = await server.inject(endpoint);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(privateValue));
    const model = parsePolicyStructure(response.json());
    assert.equal(model.availability.overall, 'unavailable');
    assert.equal(model.diagnostics[0]?.category, category, response.body);
    assert.deepEqual(model.steps, []);
    assert.deepEqual(model.data.edges, []);
  }
  await writeFile(
    join(directory, 'facts', 'definitions', `${experimentId}.json`),
    `invalid ${privateValue} JSON`,
  );
  const malformed = await server.inject(endpoint);
  assert.equal(malformed.statusCode, 200, malformed.body);
  assert.ok(!malformed.body.includes(privateValue));
  assert.equal(
    parsePolicyStructure(malformed.json()).diagnostics[0]?.category,
    'invalid-source',
  );
  await writeFile(
    join(directory, 'facts', 'definitions', `${experimentId}.json`),
    '[]',
  );
  const nonObject = await server.inject(endpoint);
  assert.equal(nonObject.statusCode, 200, nonObject.body);
  assert.equal(
    parsePolicyStructure(nonObject.json()).diagnostics[0]?.category,
    'invalid-source',
  );
  assert.equal(
    (
      await server.inject(
        '/api/observation/experiments/missing/policy-structure',
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await server.inject(
        '/api/observation/experiments/unsafe%20id/policy-structure',
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await server.inject({ method: 'POST', url: endpoint })).statusCode,
    404,
  );
});

test('Policy structure HTTP keeps reliable flow and exposes scoped data-analysis diagnostics', async (t) => {
  const { directory, facts, server } = await fixture(t);
  const lock = savedDefinition(directory);
  const policy = object(lock.policy);
  assert.ok(Array.isArray(policy.steps));
  const step = object(policy.steps[0]);
  object(step.with).candidate = `\${{ input.value + '${privateValue}' + }}`;
  await facts.write('definitions', experimentId, relock(lock));
  const response = await server.inject(endpoint);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(!response.body.includes(privateValue));
  const model = parsePolicyStructure(response.json());
  assert.equal(model.availability.overall, 'partial');
  assert.equal(model.availability.flow, 'complete');
  assert.equal(model.availability.data, 'partial');
  assert.equal(model.steps.length, 1);
  const diagnostic = model.diagnostics.find(
    (entry) => entry.category === 'analysis',
  );
  assert.equal(diagnostic?.view, 'data');
  assert.equal(diagnostic?.nodeId, model.steps[0]?.id);
  assert.match(diagnostic?.location ?? '', /with\/candidate/);
  assert.throws(() =>
    parsePolicyStructure({ ...model, availability: { overall: 'complete' } }),
  );
  assert.throws(() =>
    parsePolicyStructure({
      ...model,
      source: { ...model.source, snapshot: 'current' },
    }),
  );
});

test('Policy structure redaction preserves protocol tags when credentials match their text', async (t) => {
  const { directory, facts, server } = await fixture(t);
  const lock = savedDefinition(directory);
  const bindingConfig = object(
    object(object(object(lock.recipe).bindings).worker).config,
  );
  bindingConfig.token = 'initial';
  bindingConfig.password = 'complete';
  const policy = object(lock.policy);
  assert.ok(Array.isArray(policy.steps));
  object(object(policy.steps[0]).with).note = "${{ 'initial complete' }}";
  await facts.write('definitions', experimentId, relock(lock));
  const response = await server.inject(endpoint);
  assert.equal(response.statusCode, 200, response.body);
  const model = parsePolicyStructure(response.json());
  assert.equal(model.source.snapshot, 'initial');
  assert.equal(model.availability.overall, 'complete');
  const configuration = object(model.bindings[0]?.configuration);
  assert.equal(configuration.token, '[REDACTED]');
  assert.equal(configuration.password, '[REDACTED]');
  const detail = model.details.find(
    (entry) => entry.id === model.steps[0]?.detailId,
  );
  const declaration = object(detail?.declaration);
  assert.ok(!JSON.stringify(declaration).includes('initial complete'));
  assert.match(JSON.stringify(declaration), /REDACTED/);
});

test('Policy structure redaction keeps distinct identities when source names are credential values', async (t) => {
  const { directory, facts, server } = await fixture(t);
  const lock = savedDefinition(directory);
  const bindingConfig = object(
    object(object(object(lock.recipe).bindings).worker).config,
  );
  bindingConfig.token = 'input';
  bindingConfig.password = 'state';
  await facts.write('definitions', experimentId, relock(lock));
  const response = await server.inject(endpoint);
  assert.equal(response.statusCode, 200, response.body);
  const model = parsePolicyStructure(response.json());
  assert.equal(model.availability.overall, 'complete');
  const input = model.data.nodes.find((entry) => entry.kind === 'input');
  const state = model.data.nodes.find((entry) => entry.kind === 'state');
  assert.ok(input);
  assert.ok(state);
  assert.notEqual(input.id, state.id);
  assert.ok(model.data.edges.some((entry) => entry.source.nodeId === input.id));
  assert.ok(model.data.edges.some((entry) => entry.source.nodeId === state.id));
});
