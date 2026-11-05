import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedObservation } from '../fixtures/observation/seed.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { FileFacts } from '../../src/runtime/storage/index.js';
import type { JsonObject } from '../../src/contracts/index.js';

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

test('observation filters streamed facts by experiment before paging and provenance projection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-scoped-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('calls', 'call-second', {
    ...(await facts.read('calls', 'call-second')),
    bindingId: null,
  });
  await facts.write('candidates', 'z-unselected', {
    experimentId: 'run-alpha',
    ref: 'z-unselected',
    artifactRef: null,
  });
  await facts.write('calls', 'origin-parent', {
    experimentId: 'run-alpha',
    callId: 'origin-parent',
    bindingId: 'agent',
    pluginId: 'agent.pi',
    status: 'succeeded',
    path: 'loop/3/propose',
    startedAt: '2026-11-01',
  });
  await facts.write('calls', 'origin-child', {
    experimentId: 'run-alpha',
    callId: 'origin-child',
    bindingId: 'agent',
    pluginId: 'agent.pi',
    status: 'succeeded',
    parentCallId: 'origin-parent',
    output: { candidateRef: 'candidate-next' },
    startedAt: '2026-11-02',
  });
  await facts.write('calls', 'foreign', {
    experimentId: 'run-beta',
    callId: 'foreign',
    status: 'succeeded',
    output: { candidateRef: 'candidate-next' },
    path: 'loop/99/propose',
  });
  let callScans = 0;
  const queries = new ObservationQueries(
    {
      read: facts.read.bind(facts),
      async list() {
        throw new Error('Bulk list forbidden');
      },
      async *scan(kind) {
        if (kind === 'calls') callScans++;
        yield* facts.scan(kind);
      },
    },
    artifacts,
  );
  const [calls, candidates] = await Promise.all([
    queries.calls('run-alpha', 0, 1),
    queries.candidates('run-alpha', 0, 1),
  ]);
  assert.equal(callScans, 1);
  assert.equal(calls.total, 4);
  assert.equal(calls.items[0]?.callId, 'call-first');
  assert.equal(candidates.total, 3);
  assert.equal(candidates.items[0]?.ref, 'candidate-next');
  assert.equal(candidates.items[0]?.originPath, 'loop/3/propose');
  assert.equal(candidates.nextOffset, 1);
});

test('observation compacts a lazy fact stream without bulk payload reads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-observation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  for (let i = 0; i < 3; i++)
    await facts.write('calls', `large-${i}`, {
      experimentId: 'run-alpha',
      callId: `large-${i}`,
      bindingId: 'agent',
      pluginId: 'agent.pi',
      status: 'running',
      input: { payload: 'x'.repeat(500_000) },
    });
  class StreamingFacts extends FileFacts {
    callReads = 0;
    callStreams = 0;
    override async read(kind: string, id: string): Promise<JsonObject> {
      if (kind === 'calls') this.callReads++;
      return super.read(kind, id);
    }
    override async list(): Promise<JsonObject[]> {
      throw new Error('Bulk list forbidden');
    }
    override async *scan(kind: string): AsyncGenerator<JsonObject> {
      if (kind === 'calls') this.callStreams++;
      let first = true;
      for await (const record of super.scan(kind)) {
        if (kind === 'calls' && first) assert.equal(this.callReads, 1);
        first = false;
        yield record;
      }
    }
  }
  const streaming = new StreamingFacts(join(directory, 'facts'));
  const queries = new ObservationQueries(streaming, artifacts);
  const [calls] = await Promise.all([
    queries.calls('run-alpha'),
    queries.candidates('run-alpha'),
  ]);
  assert.equal(streaming.callStreams, 1);
  assert.equal(streaming.callReads, 6);
  assert.equal(calls.total, 5);
  assert.ok(JSON.stringify(calls).length < 10_000);
});
