import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedObservation } from '../fixtures/observation/seed.js';
import { createServer } from '../../src/entries/web/server.js';
import {
  parseDetails,
  parseArtifact,
} from '../../web/api/observation-client.js';

test('recorded content is owned, redacted, bounded, paginated and read-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const file = (
    path: string,
    text: string,
  ): { path: string; mode: number; base64: string } => ({
    path,
    mode: 0o644,
    base64: Buffer.from(text).toString('base64'),
  });
  const treeRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      file(
        'prompt.md',
        'Task fixture-private-value\napi_key: file-private-key\nSafe content',
      ),
      file('.env', 'PRIVATE=hidden'),
      file('long.txt', 'x'.repeat(40000)),
      file('large.txt', 'x'.repeat(1024 * 1024 + 1)),
      file('binary.dat', '\0binary'),
    ],
  });
  const jsonRef = await artifacts.putJson({
    password: 'artifact-private',
    message: 'artifact-private',
    value: 0,
  });
  const foreignRef = await artifacts.putJson({ foreign: true });
  const malformedRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [file('../outside', 'escape')],
  });
  await facts.write('candidates', 'candidate-root', {
    ...(await facts.read('candidates', 'candidate-root')),
    artifactRef: treeRef,
  });
  await facts.write('experiments', 'run-alpha', {
    ...(await facts.read('experiments', 'run-alpha')),
    output: { artifactRef: jsonRef, malformedRef },
  });
  const snapshot = async (): Promise<string> =>
    JSON.stringify(
      await Promise.all(
        (await readdir(directory, { recursive: true }))
          .filter((path) => path.endsWith('.json'))
          .sort()
          .map(async (path) => [
            path,
            await readFile(join(directory, path), 'utf8'),
          ]),
      ),
    );
  const before = await snapshot();
  const server = await createServer({
    manager: {
      facts,
      artifacts,
      list: () => facts.list('experiments'),
      get: (id) => facts.read('experiments', id),
      run: async () => {
        throw new Error('must not run');
      },
      cancel: async () => {
        throw new Error('must not cancel');
      },
    },
    registry: { catalog: () => ({ plugins: [], policies: [] }) },
  });
  t.after(() => server.close());
  const get = (path: string) =>
    server.inject('/api/observation/experiments' + path);
  const response = await get('/run-alpha/details');
  assert.equal(response.statusCode, 200);
  const details = parseDetails(response.json());
  assert.match(details.configuration!.text, /REDACTED/);
  assert.ok(!response.body.includes('fixture-private-value'));
  assert.equal(
    parseDetails((await get('/run-other/details')).json()).configuration,
    null,
  );
  const endpoint = '/run-alpha/artifacts/' + encodeURIComponent(treeRef);
  const listing = parseArtifact(
    (await get(endpoint + '?limit=1&offset=1')).json(),
  );
  assert.equal(listing.files?.total, 5);
  assert.equal(listing.files?.nextOffset, 2);
  assert.equal(listing.files?.items[0]?.path, '.env');
  const content = parseArtifact(
    (await get(endpoint + '?path=prompt.md')).json(),
  );
  assert.match(content.content!.text, /Safe content/);
  assert.ok(!content.content!.text.includes('fixture-private-value'));
  assert.ok(!content.content!.text.includes('file-private-key'));
  assert.match(
    parseArtifact((await get(endpoint + '?path=.env')).json()).unavailable!,
    /restricted/,
  );
  assert.match(
    parseArtifact((await get(endpoint + '?path=binary.dat')).json())
      .unavailable!,
    /Binary/,
  );
  assert.match(
    parseArtifact((await get(endpoint + '?path=large.txt')).json())
      .unavailable!,
    /limit/,
  );
  const long = parseArtifact((await get(endpoint + '?path=long.txt')).json());
  assert.equal(long.content?.text.length, 32768);
  assert.equal(long.content?.truncated, true);
  const json = await get('/run-alpha/artifacts/' + encodeURIComponent(jsonRef));
  assert.ok(!json.body.includes('artifact-private'));
  assert.match(parseArtifact(json.json()).content!.text, /REDACTED/);
  for (const path of [
    '/run-alpha/artifacts/' + encodeURIComponent(foreignRef),
    '/run-other/artifacts/' + encodeURIComponent(treeRef),
    endpoint + '?path=..%2Foutside',
  ])
    assert.equal((await get(path)).statusCode, 404);
  assert.equal(
    (await get('/run-alpha/artifacts/' + encodeURIComponent(malformedRef)))
      .statusCode,
    400,
  );
  assert.equal((await get(endpoint + '?limit=101')).statusCode, 400);
  assert.equal((await get('/missing/details')).statusCode, 404);
  assert.equal(await snapshot(), before);
});

test('content query validates nested result references against this experiment', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-content-refs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const treeRef = await artifacts.putJson({ kind: 'file-tree', files: [] });
  await facts.write('candidates', 'candidate-root', {
    ...(await facts.read('candidates', 'candidate-root')),
    artifactRef: treeRef,
  });
  const other = await facts.read('experiments', 'run-alpha');
  await facts.write('experiments', 'run-alpha', {
    ...other,
    output: {
      'chosen/version': { value: 'candidate-root' },
      evidence: treeRef,
      arbitraryMeasurement: ['measurement-first'],
      candidateRef: 'not-recorded',
      foreign: 'call-other',
      password: 'candidate-next',
    },
  });
  const { ObservationQueries } = await import(
    '../../src/runtime/services/observation.js'
  );
  const query = new ObservationQueries(facts, artifacts);
  const before = await facts.read('experiments', 'run-alpha');
  const details = parseDetails(await query.details('run-alpha'));
  assert.deepEqual(
    [...details.resultReferences].sort((a, b) => a.path.localeCompare(b.path)),
    [
      {
        kind: 'candidate',
        ref: 'candidate-root',
        path: '/chosen~1version/value',
      },
      {
        kind: 'measurement',
        ref: 'measurement-first',
        path: '/arbitraryMeasurement/0',
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.deepEqual(await facts.read('experiments', 'run-alpha'), before);
  assert.throws(
    () =>
      parseDetails({
        ...details,
        resultReferences: [{ kind: 'plugin-private', ref: 'guess', path: '' }],
      }),
    /result reference kind/,
  );
});
