import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createRuntime } from '../../src/runtime/context.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { createServer } from '../../src/entries/web/server.js';

const execute = promisify(execFile);
const cli = resolve('src/entries/cli/main.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const applicationModule = pathToFileURL(
  resolve('src/contracts/plugin-types/application.ts'),
).href;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-external-'));
  await mkdir(join(root, 'extension'));
  await writeFile(
    join(root, 'extension/index.mjs'),
    `
import { fileURLToPath } from 'node:url';
import { applicationContract } from ${JSON.stringify(applicationModule)};
export async function register(registry) {
  registry.registerOperation({
    id: 'external.application', contract: applicationContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create() {
      return {
        async execute(input, context) {
          if (input.action !== 'initialize') throw Error('Unexpected action');
          const artifact = await context.artifacts.putJson({ kind: 'file-tree', files: [] });
          return { action: 'initialize', capabilities: [], target: {},
            initialCandidateRef: await context.recordCandidate(artifact, null) };
        },
        async dispose() {},
      };
    },
  });
  registry.registerPolicy('external.policy', fileURLToPath(new URL('./policy.yaml', import.meta.url)));
}
`,
  );
  await writeFile(
    join(root, 'extension/policy.yaml'),
    `schemaVersion: rsi.policy/v1
id: external.policy
input_schema: { type: object }
output_schema: { type: object }
output: { loaded: true }
`,
  );
  await writeFile(
    join(root, 'recipe.yaml'),
    `schemaVersion: rsi.recipe/v1
id: external-recipe
application: { ref: external.application, config: {} }
policy: { ref: external.policy, config: {}, input: {} }
bindings: {}
budget: { operations: 5, elapsedWallMs: 30000 }
`,
  );
  return root;
}

test('CLI loads external implementation and Policy for catalog, validate and execution', async () => {
  const root = await fixture();
  const run = async (...args: string[]): Promise<Record<string, unknown>> => {
    const result = await execute(
      process.execPath,
      ['--import', tsx, cli, ...args],
      { timeout: 30000, cwd: root },
    );
    return JSON.parse(result.stdout);
  };
  try {
    const extension = join(root, 'extension');
    const catalog = await run('catalog', '--plugin-dir', extension);
    assert.ok(
      Array.isArray(catalog.plugins) &&
        catalog.plugins.includes('external.application'),
    );
    assert.ok(
      Array.isArray(catalog.policies) &&
        catalog.policies.includes('external.policy'),
    );
    assert.equal(
      (
        await run(
          'validate',
          join(root, 'recipe.yaml'),
          '--plugin-dir',
          extension,
        )
      ).valid,
      true,
    );
    const executed = await run(
      'run',
      'recipe.yaml',
      '--id',
      'cli-run',
      '--plugin-dir',
      './extension',
    );
    assert.equal(executed.status, 'succeeded');
    assert.deepEqual(executed.output, { loaded: true });
    // A second extension and a repeated directory exercise ordered loading and deduplication.
    await mkdir(join(root, 'second'));
    await writeFile(
      join(root, 'second/index.mjs'),
      `export function register(registry) {
      if (!registry.catalog().plugins.includes('external.application')) throw Error('Wrong load order');
    }`,
    );
    const program = await createRuntime({
      rootDirectory: root,
      directory: join(root, '.rsi'),
      pluginDirectories: [extension, join(root, 'second'), extension],
    });
    try {
      const server = await createServer(program);
      try {
        const response = await server.inject({ url: '/api/catalog' });
        assert.ok(response.json().policies.includes('external.policy'));
      } finally {
        await server.close();
      }
      const result = await program.manager.run(join(root, 'recipe.yaml'), {
        id: 'external-run',
      });
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(result.output, { loaded: true });
    } finally {
      await program.dispose();
    }
    await assert.rejects(
      run('catalog', '--plugin-dir'),
      /--plugin-dir.*argument missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed extension registration reports its directory and disposes prior registrations', async () => {
  const root = await fixture();
  const registry = new Registry();
  try {
    await mkdir(join(root, 'broken'));
    await writeFile(
      join(root, 'broken/index.mjs'),
      `export async function register() { throw Error('registration failed'); }`,
    );
    await assert.rejects(
      createRuntime({
        registry,
        pluginDirectories: [join(root, 'extension'), join(root, 'broken')],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes('broken') &&
        error.cause instanceof Error &&
        error.cause.message === 'registration failed',
    );
    assert.deepEqual(registry.catalog(), { plugins: [], policies: [] });
    await mkdir(join(root, 'invalid'));
    await writeFile(
      join(root, 'invalid/index.mjs'),
      'export const unrelated = true;',
    );
    await assert.rejects(
      createRuntime({ pluginDirectories: [join(root, 'invalid')] }),
      /plugin directory/,
    );
    await assert.rejects(
      createRuntime({ pluginDirectories: [join(root, 'missing')] }),
      /plugin directory/,
    );
    await mkdir(join(root, 'collision'));
    await writeFile(
      join(root, 'collision/index.mjs'),
      `export function register(registry) { registry.registerPolicy('external.policy', 'unused.yaml'); }`,
    );
    await assert.rejects(
      createRuntime({
        pluginDirectories: [join(root, 'extension'), join(root, 'collision')],
      }),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /Duplicate ID/.test(error.cause.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('home discovery loads extensions once and CLI describes schemas', async () => {
  const root = await fixture();
  try {
    const home = join(root, '.ember-rsi');
    await mkdir(join(home, 'plugins'), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(join(root, 'extension'), join(home, 'plugins', 'demo'));
    const runtime = await createRuntime({
      homeDirectory: home,
      pluginDirectories: [join(home, 'plugins', 'demo')],
    });
    try {
      assert.ok(
        runtime.registry.catalog().plugins.includes('external.application'),
      );
    } finally {
      await runtime.dispose();
    }
    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execute(
        process.execPath,
        ['--import', tsx, cli, ...args],
        {
          cwd: root,
          timeout: 30000,
          env: { ...process.env, USERPROFILE: root, HOME: root },
        },
      );
      return JSON.parse(result.stdout);
    };
    const plugins = (await run('list', 'plugins')) as {
      id: string;
      contract: string;
      input_schema: unknown;
      output_schema: unknown;
      config_schema: unknown;
      compatiblePolicies: unknown[];
    }[];
    const plugin = plugins.find((entry) => entry.id === 'external.application');
    assert.equal(plugin?.contract, 'contract.application');
    assert.ok(
      plugin?.input_schema && plugin.output_schema && plugin.config_schema,
    );
    const proposer = plugins.find((entry) => entry.id === 'proposer.agent');
    assert.ok(proposer?.compatiblePolicies.length);
    const policies = (await run('list', 'policies')) as {
      id: string;
      require: unknown;
    }[];
    assert.ok(policies.length && policies.every((entry) => entry.require));
    assert.deepEqual(await run('list'), []);
    await assert.rejects(run('list', 'typo'), /invalid.*kind|Allowed choices/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing home is allowed, isolation disables discovery, and broken home extensions fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-home-'));
  try {
    const runtime = await createRuntime({ homeDirectory: root });
    await runtime.dispose();
    await mkdir(join(root, 'plugins', 'broken'), { recursive: true });
    await assert.rejects(
      createRuntime({ homeDirectory: root }),
      /Failed to load plugin directory/,
    );
    const isolated = await createRuntime({ homeDirectory: false });
    await isolated.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
