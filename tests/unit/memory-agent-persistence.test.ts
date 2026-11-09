import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type JsonObject,
  type MemoryInput,
} from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { createMemoryAgent } from '../../src/plugins/memory-agent/service.js';

/** The agent contract delivers a managed workspace; editable files live
 * under candidate/ and read-only context keeps its own paths. */
async function workspaceFiles(cwd: string): Promise<JsonObject> {
  const files: JsonObject = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(cwd, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[
          path.startsWith('candidate/') ? path.slice('candidate/'.length) : path
        ] = await readFile(join(cwd, path), 'utf8');
    }
  };
  await walk('');
  return files;
}

function servicesFor(
  root: string,
  artifacts: InstanceType<typeof FileArtifacts>,
  invokeAgent: (agentRef: string, request: JsonObject) => Promise<JsonObject>,
): RuntimeContext {
  return new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    artifacts,
    workspaces: {
      create: async () => {
        const directory = join(
          root,
          `workspace-${Date.now()}-${Math.random()}`,
        );
        await mkdir(directory, { recursive: true });
        return { ref: directory, directory, parentCandidateRef: null };
      },
      read: async () => ({
        ref: root,
        directory: root,
        parentCandidateRef: null,
      }),
      release: async () => {},
    },
    readEvidence: async () => ({}),
    invokeAgent,
    charge: async () => {},
  });
}

function call(context: RuntimeContext): RuntimeContext {
  return context.extend({
    experimentId: 'memory-test',
    callId: 'memory-call',
    bindingId: 'memory',
    idempotencyKey: 'memory-call',
    directory: join(context.rootDirectory!, '.rsi/calls/test'),
    signal: new AbortController().signal,
    cleanup: AbortSignal.timeout(10000),
  });
}

async function seedWiki(directory: string): Promise<void> {
  await mkdir(join(directory, 'wiki/patterns'), { recursive: true });
  await writeFile(
    join(directory, 'wiki/index.md'),
    '# kernel-opt memory\n\nKnown compile pitfalls live here.\n',
  );
  await writeFile(
    join(directory, 'wiki/patterns/hivm-plan-memory.md'),
    '# hivm-plan-memory\n\nKeep `*_SUB` strictly smaller than its BLOCK.\n',
  );
}

function input(): MemoryInput {
  return {
    memoryRef: null,
    goal: 'Consolidate this run into the memory wiki',
    evidenceRefs: ['m-1'],
  };
}

test('memory-agent seeds from the configured directory and persists the updated wiki back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-memory-persist-'));
  try {
    const seed = join(root, 'memory-store');
    const persist = join(root, 'memory-store');
    await seedWiki(seed);
    const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
    let seenFiles: JsonObject | null = null;
    const services = servicesFor(
      root,
      artifacts,
      async (_agentRef, request) => {
        seenFiles = await workspaceFiles(String(request.cwd));
        return {
          edits: [
            {
              path: 'wiki/log.md',
              content: '# log\n\nround 1: hivm failure\n',
            },
          ],
          reason: 'recorded the run',
        };
      },
    );
    const operation = await createMemoryAgent(
      {
        prompt: 'src/policies/harness2/memory.md',
        seedDirectory: seed,
        persistDirectory: persist,
      },
      services,
    );
    const output = await operation.execute(input(), call(services));
    assert.equal(output.status, 'updated');
    assert.ok(output.memoryRef);
    // The agent saw the seeded wiki as its editable baseline.
    assert.ok(seenFiles && 'wiki/index.md' in seenFiles);
    assert.ok(seenFiles && 'wiki/patterns/hivm-plan-memory.md' in seenFiles);
    // The updated wiki (seed + log) is mirrored back to the host directory.
    assert.match(
      await readFile(join(persist, 'wiki/log.md'), 'utf8'),
      /round 1: hivm failure/,
    );
    assert.match(
      await readFile(join(persist, 'wiki/index.md'), 'utf8'),
      /Known compile pitfalls/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory-agent resolves ${VAR} seed and persist directories and rejects missing variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-memory-env-'));
  const previous = process.env.RSI_MEMORY_TEST_DIR;
  try {
    const seed = join(root, 'env-store');
    const persist = join(root, 'env-store-persist');
    await seedWiki(seed);
    process.env.RSI_MEMORY_TEST_DIR = persist;
    const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
    const services = servicesFor(root, artifacts, async () => ({
      edits: [{ path: 'wiki/log.md', content: '# log\n\nenv round\n' }],
      reason: 'recorded the run',
    }));
    const operation = await createMemoryAgent(
      {
        prompt: 'src/policies/harness2/memory.md',
        seedDirectory: seed,
        persistDirectory: '${RSI_MEMORY_TEST_DIR}',
      },
      services,
    );
    const output = await operation.execute(input(), call(services));
    assert.equal(output.status, 'updated');
    assert.match(
      await readFile(join(persist, 'wiki/log.md'), 'utf8'),
      /env round/,
    );
    const missing = await createMemoryAgent(
      {
        prompt: 'src/policies/harness2/memory.md',
        seedDirectory: '${RSI_MEMORY_TEST_MISSING}',
      },
      services,
    );
    // Ember's memory.agent reports agent failures as a failed outcome
    // instead of rejecting the call; only abort/budget errors rethrow.
    const failed = (await missing.execute(
      input(),
      call(services),
    )) as JsonObject;
    assert.equal(failed.status, 'failed');
    assert.match(String(failed.reason), /missing environment variable/);
  } finally {
    if (previous === undefined) delete process.env.RSI_MEMORY_TEST_DIR;
    else process.env.RSI_MEMORY_TEST_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('memory-agent skips seeding when the directory is missing or empty and persists nothing without a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-memory-persist-'));
  try {
    const empty = join(root, 'empty-store');
    await mkdir(empty, { recursive: true });
    const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
    const services = servicesFor(root, artifacts, async () => ({
      edits: [],
      reason: 'nothing to record yet',
    }));
    const missing = await createMemoryAgent(
      {
        prompt: 'src/policies/harness2/memory.md',
        seedDirectory: join(root, 'does-not-exist'),
      },
      services,
    );
    const noSeed = (await missing.execute(
      input(),
      call(services),
    )) as JsonObject;
    assert.equal(noSeed.status, 'no-change');
    assert.equal(noSeed.memoryRef, null);

    const blank = await createMemoryAgent(
      { prompt: 'src/policies/harness2/memory.md', seedDirectory: empty },
      services,
    );
    const emptySeed = (await blank.execute(
      input(),
      call(services),
    )) as JsonObject;
    assert.equal(emptySeed.status, 'no-change');
    assert.equal(emptySeed.memoryRef, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory-agent keeps an existing memoryRef and never seeds over it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-memory-persist-'));
  try {
    const seed = join(root, 'memory-store');
    await seedWiki(seed);
    const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
    const existing = await artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'wiki/index.md',
          mode: 420,
          base64: Buffer.from('# existing wiki\n').toString('base64'),
        },
      ],
    });
    let seededRefSeen: string | null = null;
    const services = servicesFor(
      root,
      artifacts,
      async (_agentRef, request) => {
        seededRefSeen = 'checked';
        assert.equal(
          (await workspaceFiles(String(request.cwd)))['wiki/index.md'],
          '# existing wiki\n',
        );
        return {
          edits: [{ path: 'wiki/log.md', content: '# log\n' }],
          reason: 'append',
        };
      },
    );
    const operation = await createMemoryAgent(
      { prompt: 'src/policies/harness2/memory.md', seedDirectory: seed },
      services,
    );
    const output = await operation.execute(
      { ...input(), memoryRef: existing },
      call(services),
    );
    assert.equal(output.status, 'updated');
    assert.equal(seededRefSeen, 'checked');
    // Without persistDirectory nothing is written outside the artifact store.
    const exists = await readFile(join(seed, 'wiki/log.md'), 'utf8').then(
      () => true,
      () => false,
    );
    assert.equal(exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
