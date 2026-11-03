import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../src/entries/web/server.js';
import { seedObservation } from '../fixtures/observation/seed.js';
import {
  parseExperiments,
  parseOverview,
  parseCalls,
  parseCallDetail,
  parseCandidates,
  parseMeasurements,
  parseMetricRecords,
  readObservation,
} from '../../web/api/observation-client.js';

test('observation HTTP projects existing facts, isolates experiments and never mutates stores', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const snapshot = async (): Promise<string> => {
    const paths = (await readdir(directory, { recursive: true }))
      .filter((path) => path.endsWith('.json'))
      .sort();
    return JSON.stringify(
      await Promise.all(
        paths.map(async (path) => [
          path,
          await readFile(join(directory, path), 'utf8'),
        ]),
      ),
    );
  };
  const before = await snapshot();
  const server = await createServer({
    manager: {
      facts,
      artifacts,
      list: () => facts.list('experiments'),
      get: (id) => facts.read('experiments', id),
      run: async () => {
        throw new Error('Observation must not run experiments');
      },
      cancel: async () => {
        throw new Error('Observation must not cancel experiments');
      },
    },
    registry: { catalog: () => ({ plugins: [], policies: [] }) },
  });
  t.after(() => server.close());
  const get = async (path: string): Promise<unknown> => {
    const response = await server.inject('/api/observation/experiments' + path);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('fixture-private-value'));
    assert.ok(!response.body.includes('second-private-value'));
    return response.json();
  };
  const list = parseExperiments(await get('?limit=1'));
  assert.equal(list.total, 2);
  assert.equal(list.nextOffset, 1);
  assert.equal(list.items[0]?.id, 'run-alpha');
  assert.equal(
    parseExperiments(await get('?limit=1&offset=1')).items[0]?.id,
    'run-other',
  );
  const overview = parseOverview(await get('/run-alpha'));
  assert.equal(overview.usage?.operations, 12);
  assert.equal(overview.limits.modelCalls, 20);
  assert.match(overview.output!.text, /REDACTED/);
  assert.equal(parseOverview(await get('/run-other')).usage, null);
  const calls = parseCalls(await get('/run-alpha/calls?limit=1'));
  assert.equal(calls.total, 2);
  assert.equal(calls.items[0]?.pluginId, 'unfamiliar.plugin');
  assert.equal(
    parseCalls(await get('/run-alpha/calls?offset=1')).items[0]?.status,
    'unknown',
  );
  const detail = parseCallDetail(await get('/run-alpha/calls/call-first'));
  assert.ok(!detail.input?.text.includes('private-header'));
  assert.equal(detail.parentCallId, 'root');
  const candidates = parseCandidates(await get('/run-alpha/candidates'));
  assert.equal(
    candidates.items.find((item) => item.ref === 'candidate-next')?.parentRef,
    'candidate-root',
  );
  const measurements = parseMeasurements(await get('/run-alpha/measurements'));
  assert.equal(measurements.items[0]?.metrics[0]?.values.value, 0);
  assert.equal(measurements.items[0]?.metrics[0]?.unit, 'ratio');
  assert.deepEqual(measurements.items[1]?.metrics[0]?.values, {});
  assert.equal(measurements.items[1]?.comparisonKey, null);
  assert.equal(
    measurements.items[1]?.metrics[0]?.reason,
    'Evaluation interrupted',
  );
  assert.equal(
    parseMeasurements(
      await get('/run-alpha/measurements?candidate=candidate-next'),
    ).total,
    1,
  );
  assert.equal(
    parseMeasurements(await get('/run-alpha/measurements?candidate=missing'))
      .total,
    0,
  );
  for (const path of [
    '/missing',
    '/missing/calls',
    '/run-alpha/calls/call-other',
  ])
    assert.equal(
      (await server.inject('/api/observation/experiments' + path)).statusCode,
      404,
    );
  for (const query of [
    '?limit=101',
    '?limit=0',
    '?offset=-1',
    '?offset=0.5',
    '?extra=value',
  ])
    assert.equal(
      (await server.inject('/api/observation/experiments' + query)).statusCode,
      400,
    );
  assert.equal(
    (
      await server.inject({
        url: '/api/observation/experiments',
        headers: { origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: '/api/observation/experiments',
      })
    ).statusCode,
    404,
  );
  assert.equal(await snapshot(), before);
  await facts.write('calls', 'call-first', {
    ...(await facts.read('calls', 'call-first')),
    output: { text: 'x'.repeat(40000) },
  });
  const large = parseCallDetail(await get('/run-alpha/calls/call-first'));
  assert.equal(large.output?.truncated, true);
  assert.equal(large.output?.text.length, 32768);
  await writeFile(
    join(directory, 'facts/budgets/run-alpha.json'),
    'invalid JSON',
  );
  assert.equal(
    (await server.inject('/api/observation/experiments/run-alpha')).statusCode,
    400,
  );
});

test('observation client rejects invalid payloads and propagates failures and cancellation', async (t) => {
  assert.throws(() => parseCalls({ total: 1, nextOffset: null, items: [{}] }));
  assert.throws(() =>
    parseExperiments({ total: -1, nextOffset: null, items: [] }),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }),
  );
  await assert.rejects(readObservation('', parseExperiments), /Unavailable/);
  t.mock.restoreAll();
  const controller = new AbortController();
  controller.abort(new Error('Navigated away'));
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response('{}');
    },
  );
  await assert.rejects(
    readObservation('', parseExperiments, controller.signal),
    /Navigated away/,
  );
});

test('item observations paginate, preserve item conditions and failures, and isolate ownership', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-item-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const first = await facts.read('measurements', 'measurement-first');
  const metric = (first.metrics as Record<string, unknown>).quality;
  const itemsRef = await artifacts.putJson({
    schemaVersion: 'rsi.measurement-items/v1',
    items: [
      {
        id: 'point-a',
        subject: { kind: 'custom-point', id: 'A', parameters: null },
        status: 'succeeded',
        coverage: 'complete',
        comparisonKey: 'item-conditions',
        metrics: {
          quality: {
            ...(metric as object),
            source: { artifactRef: 'source', pointer: '' },
          },
        },
        evaluation: null,
        evidenceIndexRef: 'evidence',
        details: {
          schemaId: 'custom/v1',
          schemaDigest: 'a'.repeat(64),
          artifactRef: 'details',
        },
      },
      {
        id: 'point-b',
        subject: { kind: 'custom-point', id: 'B', parameters: null },
        status: 'failed',
        coverage: 'partial',
        comparisonKey: null,
        metrics: {},
        evaluation: null,
        evidenceIndexRef: 'evidence',
        details: {
          schemaId: 'custom/v1',
          schemaDigest: 'a'.repeat(64),
          artifactRef: 'details',
        },
      },
    ],
  });
  await facts.write('measurements', 'measurement-first', {
    ...first,
    itemsRef,
  });
  const second = await facts.read('measurements', 'measurement-second');
  await facts.write('measurements', 'measurement-second', {
    ...second,
    itemsRef: await artifacts.putJson({
      schemaVersion: 'rsi.measurement-items/v1',
      items: [],
    }),
  });
  const { ObservationQueries } = await import(
    '../../src/runtime/services/observation.js'
  );
  const queries = new ObservationQueries(facts, artifacts);
  const page = parseMetricRecords(
    await queries.metricRecords('run-alpha', 1, 1),
  );
  assert.equal(page.total, 4);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.items[0]?.item?.subjectId, 'A');
  assert.equal(page.items[0]?.comparisonKey, 'item-conditions');
  assert.equal(page.items[0]?.metrics[0]?.values.value, 0);
  const failed = (await queries.metricRecords('run-alpha', 2, 1)).items[0]!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.comparisonKey, null);
  assert.deepEqual(failed.metrics, []);
  assert.equal((await queries.metricRecords('run-other')).total, 0);
  await assert.rejects(queries.metricRecords('missing'));
  await facts.write('measurements', 'measurement-first', {
    ...first,
    itemsRef: await artifacts.putJson({ items: [] }),
  });
  await assert.rejects(queries.metricRecords('run-alpha'), /Measurement items/);
});
