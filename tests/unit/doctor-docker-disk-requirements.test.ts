import test from 'node:test';
import assert from 'node:assert/strict';
import type { PreparedTask } from 'ember-evaluator';
import {
  calculateDockerDiskRequirements,
  collectDockerStoragePlan,
  readCachedDockerImage,
  type DockerImageObservation,
  type DockerStoragePlan,
} from '../../src/runtime/doctor/docker-disk-requirements.js';

const gib = 1024 ** 3;
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function environment(
  extra: Partial<PreparedTask['solveEnv']> = {},
): PreparedTask['solveEnv'] {
  return {
    workdir: '/app',
    image: 'task:cached',
    initialFiles: [],
    runtime: [],
    resources: { storage: '1g' },
    ...extra,
  };
}

function task(
  id: string,
  solveEnv = environment(),
  verifyEnv: PreparedTask['verifyEnv'] = null,
): PreparedTask {
  return {
    input: { id, prompt: 'Storage fixture.' },
    verification: {},
    solveEnv,
    verifyEnv,
    transfer: null,
  };
}

function plan(
  tasks: PreparedTask[],
  metadataComplete = true,
): DockerStoragePlan {
  return collectDockerStoragePlan({
    tasks,
    platform: 'linux/amd64',
    gatewayImage: 'gateway:cached',
    metadataComplete,
  });
}

function inspect(
  options: {
    id?: string;
    platform?: string;
    layers?: string[];
    size?: number;
  } = {},
): unknown {
  const [os, architecture, variant] = (options.platform ?? 'linux/amd64').split(
    '/',
  );
  return [
    {
      Id: options.id ?? digest('a'),
      Os: os,
      Architecture: architecture,
      ...(variant ? { Variant: variant } : {}),
      Size: options.size ?? 900 * gib,
      RootFS: { Type: 'layers', Layers: options.layers ?? [digest('b')] },
    },
  ];
}

function observations(
  selected: DockerStoragePlan,
  inspection: (reference: string, platform: string) => unknown = (
    _reference,
    platform,
  ) => inspect({ platform }),
): DockerImageObservation[] {
  return selected.images.map((image) => ({
    reference: image.reference,
    platform: image.platform,
    inspection: inspection(image.reference, image.platform),
  }));
}

test('storage plan includes target-platform solve, verify, sidecar and SDK runtime images', () => {
  const selected = collectDockerStoragePlan({
    tasks: [
      task(
        'fixture',
        environment({
          platform: 'linux/arm64',
          services: {
            main: { image: 'unused-main:cached', properties: {} },
            database: { image: 'database:cached', properties: {} },
          },
        }),
        environment({ image: 'verify:cached' }),
      ),
      task('default', environment({ image: null })),
    ],
    platform: 'linux/amd64',
    gatewayImage: 'gateway:cached',
    defaultImage: 'default:cached',
    imageOverrides: { 'task:cached': 'task:prepared' },
    metadataComplete: true,
  });
  assert.deepEqual(
    selected.images
      .map((image) => `${image.platform}:${image.reference}`)
      .sort(),
    [
      'linux/amd64:default:cached',
      'linux/amd64:gateway:cached',
      'linux/amd64:verify:cached',
      'linux/arm64:database:cached',
      'linux/arm64:gateway:cached',
      'linux/arm64:task:prepared',
    ],
  );
  assert.ok(
    selected.images
      .find((image) => image.reference === 'task:prepared')
      ?.roles.includes('fixture.solve'),
  );
  assert.ok(
    !selected.images.some((image) => image.reference === 'unused-main:cached'),
  );
});

test('cached aliases and shared layers are deduplicated and never charged as new demand', () => {
  const selected = plan([
    task(
      'one',
      environment({ image: 'alias:one', resources: { storage: '1g' } }),
    ),
    task(
      'two',
      environment({ image: 'alias:two', resources: { storage: '2g' } }),
    ),
  ]);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected, (reference) =>
      inspect(
        reference === 'gateway:cached'
          ? {
              id: digest('d'),
              layers: [digest('b'), digest('e')],
              size: 800 * gib,
            }
          : {
              id: digest('a'),
              layers: [digest('b'), digest('c')],
              size: 900 * gib,
            },
      ),
    ),
  });
  assert.equal(result.requestedImageCount, 3);
  assert.equal(result.cachedImageCount, 2);
  assert.equal(result.cachedLayerCount, 3);
  assert.equal(result.pullBytes, 0);
  assert.equal(result.unpackBytes, 0);
  assert.equal(result.knownRequiredBytes, 2 * gib);
  assert.equal(
    result.images.find((image) => image.reference === 'alias:one')
      ?.imageSizeBytes,
    900 * gib,
  );
  assert.equal(result.buildBytes, null);
  assert.ok(
    result.unknowns.some((reason) => reason.includes('SDK derived runtime')),
  );
});

test('cached layer identities are platform-specific and a foreign architecture does not satisfy a target', () => {
  const selected = plan([
    task('amd', environment()),
    task('arm', environment({ platform: 'linux/arm64' })),
  ]);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected),
  });
  assert.equal(result.cachedLayerCount, 2);
  assert.equal(result.cachedImageCount, 2);
  assert.equal(
    readCachedDockerImage(inspect({ platform: 'linux/arm64' }), 'linux/amd64'),
    null,
  );
  assert.ok(
    readCachedDockerImage(
      inspect({ platform: 'linux/arm64/v8' }),
      'linux/arm64',
    ),
  );
  const foreign = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected, () => inspect({ platform: 'linux/arm64' })),
  });
  assert.equal(foreign.pullBytes, null);
  assert.equal(foreign.unpackBytes, null);
  assert.equal(
    foreign.images.find((image) => image.platform === 'linux/amd64')?.cached,
    false,
  );
});

test('missing target images leave pull and unpack size unknown while preserving declared demand', () => {
  const selected = plan([
    task('fixture', environment({ resources: { storage: '8GiB' } })),
  ]);
  const cached = observations(selected);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: cached.filter((image) => image.reference !== 'task:cached'),
  });
  assert.equal(result.pullBytes, null);
  assert.equal(result.unpackBytes, null);
  assert.equal(result.runtimeKnownLowerBoundBytes, 8 * gib);
  assert.equal(result.knownRequiredBytes, 8 * gib);
  assert.equal(result.cachedLayerCount, 1);
  assert.ok(
    result.unknowns.some((reason) =>
      reason.includes('incremental pull and unpack sizes are unknown'),
    ),
  );
});

test('image Size without a layer inventory does not become compressed or unpacked incremental bytes', () => {
  const selected = plan([task('fixture')]);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected, () => [
      { Id: digest('a'), Os: 'linux', Architecture: 'amd64', Size: 50 * gib },
    ]),
  });
  assert.equal(result.pullBytes, null);
  assert.equal(result.unpackBytes, null);
  assert.equal(result.cachedLayerCount, 0);
  assert.equal(result.knownRequiredBytes, gib);
  assert.ok(result.images.every((image) => image.imageSizeBytes === 50 * gib));
});

test('runtime declarations establish a lower bound without adding sequential tasks or claiming a quota', () => {
  const selected = plan([
    task(
      'one',
      environment({ resources: { storage: '24g' } }),
      environment({ resources: { storage: '48g' } }),
    ),
    task('two', environment({ resources: { storage: '80g' } })),
  ]);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected),
  });
  assert.equal(result.runtimeKnownLowerBoundBytes, 80 * gib);
  assert.equal(result.knownRequiredBytes, 80 * gib);
  assert.equal(result.runtimeBytes, null);
  assert.ok(
    result.unknowns.some((reason) => reason.includes('concurrent jobs')),
  );
});

test('multi-step accounting uses the actual shared solve environment and each verification environment', () => {
  const multi = task(
    'multi',
    environment({ image: 'shared-solve:cached', resources: { storage: '4g' } }),
  );
  multi.steps = [
    {
      name: 'first',
      task: task(
        'unused-one',
        environment({
          image: 'unused-solve:cached',
          resources: { storage: '99g' },
        }),
        environment({
          image: 'verify-one:cached',
          resources: { storage: '6g' },
        }),
      ),
    },
    {
      name: 'second',
      task: task(
        'unused-two',
        environment({
          image: 'unused-two:cached',
          resources: { storage: '100g' },
        }),
        environment({
          image: 'verify-two:cached',
          resources: { storage: '2g' },
        }),
      ),
    },
  ];
  const selected = plan([multi]);
  assert.equal(selected.runtimeKnownLowerBoundBytes, 6 * gib);
  assert.ok(
    selected.images.some((image) => image.reference === 'shared-solve:cached'),
  );
  assert.ok(
    selected.images.some((image) => image.reference === 'verify-one:cached'),
  );
  assert.ok(
    !selected.images.some((image) => image.reference.startsWith('unused')),
  );
});

test('SDK derived, solver installation and task/service build sizes remain separate unknown demand', () => {
  const selected = plan([
    task(
      'fixture',
      environment({
        image: null,
        build: {
          context: '/fixture',
          dockerfile: 'Dockerfile',
          sourceHash: 'fixture',
        },
        installation: {
          id: 'fixture-solver',
          files: [],
          commands: [],
          probes: [],
        },
        services: {
          database: {
            image: null,
            build: {
              context: '/fixture',
              dockerfile: 'Dockerfile.db',
              sourceHash: 'fixture-db',
            },
            properties: {},
          },
        },
      }),
    ),
  ]);
  const result = calculateDockerDiskRequirements({
    plan: selected,
    images: observations(selected),
  });
  assert.equal(result.buildBytes, null);
  assert.equal(result.pullBytes, null);
  assert.equal(result.unpackBytes, null);
  assert.ok(
    result.unknowns.some((reason) => reason.includes('task image build')),
  );
  assert.ok(
    result.unknowns.some((reason) => reason.includes('service image build')),
  );
  assert.ok(
    result.unknowns.some((reason) => reason.includes('SDK derived runtime')),
  );
  assert.ok(
    result.unknowns.some((reason) =>
      reason.includes('SDK solver installation'),
    ),
  );
  const rawImageWins = plan([
    task(
      'fixture',
      environment({
        image: 'task:cached',
        build: {
          context: '/unused',
          dockerfile: 'Dockerfile',
          sourceHash: 'unused',
        },
      }),
    ),
  ]);
  assert.ok(
    !rawImageWins.unknowns.some((reason) =>
      reason.includes('task image build'),
    ),
  );
});

test('incomplete metadata and malformed storage preserve uncertainty without guessing bytes', () => {
  const incomplete = plan([], false);
  const missing = calculateDockerDiskRequirements({
    plan: incomplete,
    images: observations(incomplete),
  });
  assert.equal(missing.pullBytes, null);
  assert.equal(missing.unpackBytes, null);
  assert.equal(missing.buildBytes, null);
  assert.equal(missing.runtimeBytes, null);
  assert.ok(
    missing.unknowns.some((reason) =>
      reason.includes('metadata is incomplete'),
    ),
  );
  const unknown = plan([
    task('undeclared', environment({ resources: {} })),
    task('invalid', environment({ resources: { storage: 'unknown' } })),
    task(
      'unsafe',
      environment({ resources: { storage: '999999999999999999999999e' } }),
    ),
  ]);
  assert.equal(unknown.runtimeKnownLowerBoundBytes, 0);
  assert.ok(
    unknown.unknowns.some((reason) =>
      reason.includes('resources.storage is undeclared'),
    ),
  );
  assert.ok(
    unknown.unknowns.some((reason) => reason.includes('safe byte count')),
  );
});
