import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedTask } from 'ember-evaluator';
import { createRuntime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { checkDockerDiskCapacity } from '../../src/runtime/doctor/docker-disk.js';
import type {
  DoctorCheck,
  DoctorContext,
} from '../../src/runtime/doctor/types.js';
import type { runCommand } from '../../src/runtime/doctor/process.js';
import { object } from '../../src/shared/json.js';
import type { JsonObject } from '../../src/contracts/json.js';

const gib = 1024 ** 3;
const info: JsonObject = {
  OSType: 'linux',
  Architecture: 'x86_64',
  Driver: 'overlay2',
  DockerRootDir: '/remote/docker',
};
const task: PreparedTask = {
  input: { id: 'fixture', prompt: 'storage' },
  verification: {},
  solveEnv: {
    workdir: '/app',
    image: 'fixture:task',
    runtime: [],
    initialFiles: [],
    resources: { storage: '2g' },
  },
  verifyEnv: null,
  transfer: null,
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'doctor-disk-integration-'));
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const policy = new Policy({
    schemaVersion: 'rsi.policy/v1',
    id: 'disk-test',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    steps: [],
    output: {},
  });
  const recipe = await Recipe.fromJSON(
    {
      schemaVersion: 'rsi.recipe/v1',
      id: 'disk-test',
      application: {
        plugin: 'application.agentbundle',
        config: {
          baseline: { directory: root },
          target: {
            schema: {
              schemaVersion: 'rsi.target/v1',
              id: 'fixture',
              entries: [],
            },
          },
        },
      },
      policy: { id: policy.id },
    },
    runtime.registry,
    { policy },
  );
  const checks: DoctorCheck[] = [];
  const ctx: DoctorContext = {
    binding: {
      name: 'evaluator',
      pluginId: 'evaluator.agentbench',
      config: {},
      definition: runtime.registry.get('evaluator.agentbench'),
    },
    recipe,
    registry: runtime.registry,
    runtime: runtime.context,
    directory: root,
    signal: new AbortController().signal,
    async check(id, action, options) {
      try {
        await action(ctx.signal);
        checks.push({
          id,
          status: 'passed',
          ...(options?.details
            ? { details: structuredClone(options.details) }
            : {}),
        });
        return true;
      } catch (error) {
        checks.push({
          id,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          ...(options?.details
            ? { details: structuredClone(options.details) }
            : {}),
        });
        return false;
      }
    },
    unchecked(id, reason, details) {
      checks.push({
        id,
        status: 'unchecked',
        reason,
        ...(details ? { details: structuredClone(details) } : {}),
      });
    },
    missing() {
      throw new Error('Disk capacity does not invent missing resources');
    },
  };
  return { ctx, checks };
}

function command(
  options: {
    available?: number;
    missingImage?: boolean;
    enospc?: boolean;
    api?: string;
  } = {},
) {
  const mutable: string[][] = [];
  const invoke: typeof runCommand = async (_executable, args, settings) => {
    mutable.push([...args]);
    if (args[0] === 'version')
      return { stdout: options.api ?? '1.55 1.55', stderr: '' };
    if (args[0] === 'image') {
      if (options.missingImage && args.at(-1) === 'fixture:task')
        throw new Error('No such image');
      return {
        stdout: JSON.stringify([
          {
            Id: `sha256:${'a'.repeat(64)}`,
            Os: 'linux',
            Architecture: 'amd64',
            Size: 900 * gib,
            RootFS: { Layers: [`sha256:${'b'.repeat(64)}`] },
          },
        ]),
        stderr: '',
      };
    }
    if (args[0] === 'run') {
      if (options.enospc)
        throw new Error(
          'Docker create failed: no space left on device (ENOSPC)',
        );
      const paths = JSON.parse(settings.input ?? '[]') as {
        path: string;
        label: string;
        roles: string[];
      }[];
      return {
        stdout: JSON.stringify({
          filesystems: paths.map((path) => ({
            path: path.label,
            roles: path.roles,
            availableBytes: options.available ?? 8 * gib,
            totalBytes: 16 * gib,
            filesystemId: path.roles.includes('container-writable')
              ? 'overlay'
              : 'disk',
            source: 'daemon-container-statfs',
          })),
          unknownReasons: [],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error(`Unexpected disk operation ${args[0]}`);
  };
  return { invoke, calls: mutable };
}

test('known declared storage shortage fails with exact numbers despite unknown builds, never charging cached image Size', async (t) => {
  const f = await fixture(t),
    docker = command({ available: gib });
  await checkDockerDiskCapacity(f.ctx, docker.invoke, 'remote-docker', info, {
    tasks: [task],
    metadataComplete: true,
    config: { platform: 'auto' },
    gatewayImage: 'fixture:node',
  });
  const capacity = f.checks.find(
    (check) => check.id === 'docker-disk-capacity',
  );
  assert.equal(capacity?.status, 'failed');
  assert.match(
    capacity?.reason ?? '',
    /available 1073741824 bytes, known required 2147483648 bytes, gap 1073741824 bytes/,
  );
  const requirements = object(capacity?.details?.requirements);
  assert.equal(requirements.pullBytes, 0);
  assert.equal(requirements.unpackBytes, 0);
  assert.equal(requirements.buildBytes, null);
  assert.equal(requirements.knownRequiredBytes, 2 * gib);
  assert.equal(requirements.cachedLayerCount, 1);
  assert.ok(
    docker.calls
      .filter((args) => args[0] === 'run')
      .every(
        (args) =>
          args.includes('--pull=never') && args.includes('--network=none'),
      ),
  );
  assert.equal(docker.calls.filter((args) => args[0] === 'rm').length, 2);
  assert.ok(
    docker.calls.every(
      (args) => !['pull', 'build', 'system', 'prune'].includes(args[0] ?? ''),
    ),
  );
});

test('available storage and missing layer sizes remain visible in unchecked capacity', async (t) => {
  const f = await fixture(t),
    docker = command({ missingImage: true });
  await checkDockerDiskCapacity(f.ctx, docker.invoke, 'docker', info, {
    tasks: [task],
    metadataComplete: true,
    config: {},
    gatewayImage: 'fixture:node',
  });
  const capacity = f.checks.find(
    (check) => check.id === 'docker-disk-capacity',
  );
  assert.equal(capacity?.status, 'unchecked');
  const requirements = object(capacity?.details?.requirements);
  assert.equal(requirements.pullBytes, null);
  assert.equal(requirements.unpackBytes, null);
  assert.equal(requirements.knownRequiredBytes, 2 * gib);
  assert.ok(Array.isArray(capacity?.details?.filesystems));
  assert.match(capacity?.reason ?? '', /SDK derived runtime/);
});

test('containerd root is not substituted for content store, while known runtime shortage still fails', async (t) => {
  const f = await fixture(t),
    docker = command({ available: gib });
  await checkDockerDiskCapacity(
    f.ctx,
    docker.invoke,
    'desktop-docker',
    {
      ...info,
      Driver: 'overlayfs',
      DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
    },
    {
      tasks: [task],
      metadataComplete: true,
      config: {},
      gatewayImage: 'fixture:node',
    },
  );
  const capacity = f.checks.find(
    (check) => check.id === 'docker-disk-capacity',
  );
  assert.equal(capacity?.status, 'failed');
  assert.match(
    JSON.stringify(capacity?.details),
    /content.store.*filesystem|separately configurable/,
  );
});

test('old Docker API uses matching local variant and lazy snapshotters never launch helpers or claim zero pull bytes', async (t) => {
  const f = await fixture(t),
    docker = command({ api: '1.48 1.48' });
  await checkDockerDiskCapacity(f.ctx, docker.invoke, 'docker', info, {
    tasks: [task],
    metadataComplete: true,
    config: {},
    gatewayImage: 'fixture:node',
  });
  assert.ok(
    docker.calls
      .filter((args) => args[0] === 'image')
      .every((args) => !args.includes('--platform')),
  );
  const lazy = command();
  await checkDockerDiskCapacity(
    f.ctx,
    lazy.invoke,
    'docker',
    { ...info, Driver: 'stargz' },
    {
      tasks: [task],
      metadataComplete: true,
      config: {},
      gatewayImage: 'fixture:node',
    },
  );
  assert.ok(lazy.calls.every((args) => args[0] !== 'run'));
  const last = f.checks
    .filter((check) => check.id === 'docker-disk-capacity')
    .at(-1);
  assert.equal(last?.status, 'unchecked');
  assert.equal(object(last?.details?.requirements).pullBytes, null);
});

test('ENOSPC is a proven failure even when a disk helper cannot measure free bytes', async (t) => {
  const f = await fixture(t),
    docker = command({ enospc: true });
  await checkDockerDiskCapacity(f.ctx, docker.invoke, 'docker', info, {
    tasks: [task],
    metadataComplete: true,
    config: {},
    gatewayImage: 'fixture:node',
  });
  assert.equal(
    f.checks.find((check) => check.id === 'docker-disk-space')?.status,
    'failed',
  );
  const capacity = f.checks.find(
    (check) => check.id === 'docker-disk-capacity',
  );
  assert.equal(capacity?.status, 'failed');
  assert.match(capacity?.reason ?? '', /ENOSPC/);
  assert.deepEqual(capacity?.details?.shortfalls, []);
});

test('a later daemon-root ENOSPC retains already measured writable-layer availability', async (t) => {
  const f = await fixture(t),
    docker = command();
  const failRoot: typeof runCommand = async (executable, args, options) => {
    if (args[0] === 'run' && args.includes('--mount'))
      throw new Error('ENOSPC: no space left on device');
    return docker.invoke(executable, args, options);
  };
  await checkDockerDiskCapacity(f.ctx, failRoot, 'docker', info, {
    tasks: [task],
    metadataComplete: true,
    config: {},
    gatewayImage: 'fixture:node',
  });
  const space = f.checks.find((check) => check.id === 'docker-disk-space');
  assert.equal(space?.status, 'failed');
  const filesystems = space?.details?.filesystems;
  assert.ok(Array.isArray(filesystems));
  assert.equal(object(filesystems[0]).availableBytes, 8 * gib);
  const capacity = f.checks.find(
    (check) => check.id === 'docker-disk-capacity',
  );
  assert.equal(capacity?.status, 'failed');
  assert.deepEqual(capacity?.details?.filesystems, filesystems);
});
