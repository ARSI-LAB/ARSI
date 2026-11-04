import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedObservation } from '../fixtures/observation/seed.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { traceRows } from '../../web/features/experiments/trace-model.js';
import { parseCallTrace } from '../../web/api/observation-client.js';

test('call traces enforce ownership and expose bounded original event pages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('calls', 'agent-call', {
    experimentId: 'run-alpha',
    callId: 'agent-call',
    pluginId: 'agent.pi',
    bindingId: 'agent',
    status: 'running',
    input: { apiKey: 'call-local-secret', prompt: 'fixture-private-value' },
  });
  const query = new ObservationQueries(facts, artifacts, directory);
  assert.ok((await query.callTrace('run-alpha', 'agent-call')).unavailable);
  const location = join(
    directory,
    'experiments',
    'run-alpha',
    'calls',
    'agent-call',
  );
  await mkdir(location, { recursive: true });
  const event = JSON.stringify({
    at: '2026-11-02T00:00:00Z',
    type: 'message_end',
    data: {
      text: 'fixture-private-value call-local-secret Normal instructions',
      api_key: 'hidden',
    },
  });
  await writeFile(
    join(location, 'diagnostics.jsonl'),
    event + '\n' + event + '\n' + '{partial',
  );
  const result = parseCallTrace(
    await query.callTrace('run-alpha', 'agent-call', 0, 1),
  );
  const detail = await query.callDetail('run-alpha', 'agent-call');
  assert.ok(!detail.input?.text.includes('fixture-private-value'));
  assert.ok(!result.items[0].content?.text.includes('call-local-secret'));
  assert.ok(result.items[0].content?.text.includes('Normal instructions'));
  assert.equal(result.total, 2);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.incomplete, true);
  assert.ok(!result.items[0].content?.text.includes('fixture-private-value'));
  assert.ok(result.items[0].content?.text.includes('[REDACTED]'));
  // Unrecognized values remain readable; this does not widen file redaction.
  assert.ok(result.items[0].content?.text.includes('hidden'));
  assert.equal(
    (await query.callTrace('run-alpha', 'agent-call', 1, 1)).items[0].sequence,
    1,
  );
  await assert.rejects(query.callTrace('run-other', 'agent-call'), /not found/);
  await assert.rejects(
    query.callTrace('run-alpha', 'agent-call', -1),
    /Invalid/,
  );
});

test('candidate creation paths follow recorded parent calls rather than later evaluations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-origins-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('candidates', 'round-candidate', {
    experimentId: 'run-alpha',
    ref: 'round-candidate',
    parentRef: 'base',
    artifactRef: 'artifact-placeholder',
  });
  await facts.write('calls', 'propose', {
    experimentId: 'run-alpha',
    callId: 'propose',
    path: 'loop/2/propose',
    parentCallId: 'root',
    output: { candidateRef: 'round-candidate' },
  });
  await facts.write('calls', 'commit', {
    experimentId: 'run-alpha',
    callId: 'commit',
    path: 'propose',
    parentCallId: 'propose',
    output: { candidateRef: 'round-candidate' },
  });
  const result = await new ObservationQueries(facts, artifacts).candidates(
    'run-alpha',
  );
  assert.equal(
    result.items.find((item) => item.ref === 'round-candidate')?.originPath,
    'loop/2/propose',
  );
});

test('instructions expose only the owned recorded prompt, independently of large input files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('calls', 'prompt-call', {
    experimentId: 'run-alpha',
    callId: 'prompt-call',
    pluginId: 'agent.pi',
    bindingId: 'agent',
    status: 'succeeded',
    input: {
      files: { 'large.txt': 'x'.repeat(50000) },
      prompt: 'Follow the recorded instructions. secret-fixture',
      api_key: 'secret-fixture',
    },
  });
  const query = new ObservationQueries(facts, artifacts, directory);
  const { parseCallInstructions } = await import(
    '../../web/api/observation-client.js'
  );
  const result = parseCallInstructions(
    await query.callInstructions('run-alpha', 'prompt-call'),
  );
  assert.equal(
    result.prompt?.text,
    'Follow the recorded instructions. [REDACTED]',
  );
  assert.equal(result.prompt?.truncated, false);
  const { default: Fastify } = await import('fastify');
  const { registerObservationRoutes } = await import(
    '../../src/entries/web/observation.js'
  );
  const app = Fastify();
  t.after(() => app.close());
  registerObservationRoutes(app, query);
  const response = await app.inject(
    '/api/observation/experiments/run-alpha/calls/prompt-call/instructions',
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parseCallInstructions(response.json()), result);

  await assert.rejects(
    query.callInstructions('run-other', 'prompt-call'),
    /not found/,
  );
  await facts.write('calls', 'no-prompt', {
    experimentId: 'run-alpha',
    callId: 'no-prompt',
  });
  assert.equal(
    (await query.callInstructions('run-alpha', 'no-prompt')).prompt,
    null,
  );
  await facts.write('calls', 'large-prompt', {
    experimentId: 'run-alpha',
    callId: 'large-prompt',
    input: { prompt: 'p'.repeat(40000) },
  });
  const bounded = await query.callInstructions('run-alpha', 'large-prompt');
  assert.equal(bounded.prompt?.text.length, 32768);
  assert.equal(bounded.prompt?.truncated, true);
});

test('trace redaction preserves JSON escapes and readable response content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-trace-escapes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const secrets = [
    'fixture-password\\',
    'fixture-"quoted"',
    'fixture-line\nnext',
  ];
  const query = new ObservationQueries(facts, artifacts, directory);
  for (const [index, password] of secrets.entries()) {
    const callId = `escape-call-${index}`;
    await facts.write('calls', callId, {
      experimentId: 'run-alpha',
      callId,
      pluginId: 'agent.pi',
      input: { password },
      status: 'succeeded',
    });
    const location = join(
      directory,
      'experiments',
      'run-alpha',
      'calls',
      callId,
    );
    await mkdir(location, { recursive: true });
    await writeFile(
      join(location, 'diagnostics.jsonl'),
      JSON.stringify({
        type: 'message_end',
        data: {
          message: {
            content: [{ type: 'text', text: `Before ${password} after` }],
          },
        },
      }) + '\n',
    );
    const result = parseCallTrace(await query.callTrace('run-alpha', callId));
    assert.equal(result.incomplete, false);
    assert.equal(result.items[0].content?.truncated, false);
    const content = result.items[0].content!.text;
    assert.doesNotThrow(() => JSON.parse(content));
    assert.ok(!content.includes(JSON.stringify(password).slice(1, -1)));
    const rows = traceRows(result.items);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Response');
    assert.equal(rows[0].body, 'Before [REDACTED] after');
  }
});
