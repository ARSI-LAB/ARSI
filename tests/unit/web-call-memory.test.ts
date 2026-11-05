import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedObservation } from '../fixtures/observation/seed.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';

test('call summaries share a streaming scan, preserve provenance and refresh after writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-call-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('calls', 'large-call', {
    experimentId: 'run-alpha',
    callId: 'large-call',
    bindingId: 'proposer',
    pluginId: 'proposer.agent',
    status: 'running',
    path: 'loop/2/propose',
    input: { files: 'x'.repeat(2_000_000) },
    output: { candidateRef: 'candidate-next' },
  });
  let scans = 0;
  const queries = new ObservationQueries(
    {
      read: facts.read.bind(facts),
      list: async (kind) => {
        assert.notEqual(kind, 'calls');
        return facts.list(kind);
      },
      async *scan(kind) {
        if (kind === 'calls') scans++;
        yield* facts.scan(kind);
      },
    },
    artifacts,
    directory,
  );
  const [calls, candidates] = await Promise.all([
    queries.calls('run-alpha'),
    queries.candidates('run-alpha'),
  ]);
  assert.equal(scans, 1);
  assert.ok(calls.items.some((call) => call.callId === 'large-call'));
  assert.ok(JSON.stringify(calls).length < 10_000);
  assert.equal(
    candidates.items.find((item) => item.ref === 'candidate-next')?.originPath,
    'loop/2/propose',
  );
  await facts.write('calls', 'large-call', {
    experimentId: 'run-alpha',
    callId: 'large-call',
    bindingId: 'proposer',
    pluginId: 'proposer.agent',
    status: 'succeeded',
  });
  assert.equal(
    (await queries.calls('run-alpha')).items.find(
      (call) => call.callId === 'large-call',
    )?.status,
    'succeeded',
  );
  assert.equal(scans, 2);
});

test('a failed call scan can be retried without retaining a rejected promise', async () => {
  let fail = true;
  const queries = new ObservationQueries(
    {
      async read() {
        return { id: 'run' };
      },
      async list() {
        throw new Error('Unexpected bulk read');
      },
      async *scan() {
        if (fail) throw new Error('Read failed');
        yield {
          experimentId: 'run',
          callId: 'one',
          bindingId: 'agent',
          pluginId: 'agent.pi',
          status: 'succeeded',
        };
      },
    },
    {
      async readJson() {
        return {};
      },
    },
  );
  await assert.rejects(queries.calls('run'), /Read failed/);
  fail = false;
  assert.equal((await queries.calls('run')).total, 1);
});
