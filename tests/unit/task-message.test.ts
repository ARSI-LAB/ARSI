import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  messageTemplatesSchema,
  renderTaskMessage,
} from '../../src/plugins/shared/agent-editing/task-message.js';
import { resolveConfig } from '../../src/runtime/loaders/config.js';
import { validate } from '../../src/shared/schema.js';

test('uses the stage override and replaces placeholders once without changing whitespace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-task-message-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = join(root, 'default.md');
  const diagnose = join(root, 'diagnose.md');
  await writeFile(fallback, 'Default: {{goal}}\n');
  await writeFile(
    diagnose,
    '  {{goal}}\nRound {{ round }}.  \n`{"example":{"nested":true}}`\n',
  );
  const context = {
    bindingId: 'proposer',
    signal: new AbortController().signal,
  };
  const common = { goal: '{{round}} 调整' };
  const stage = { name: 'diagnose-metrics', variables: { round: 3 } };
  assert.equal(
    await renderTaskMessage(
      context,
      { default: fallback, 'diagnose-metrics': diagnose },
      'Built-in',
      common,
      stage,
    ),
    '  {{round}} 调整\nRound 3.  \n`{"example":{"nested":true}}`\n',
  );
  assert.equal(
    await renderTaskMessage(
      context,
      { default: fallback },
      'Built-in',
      common,
      stage,
    ),
    'Default: {{round}} 调整\n',
  );
  assert.equal(
    await renderTaskMessage(context, undefined, 'Built-in', common, stage),
    'Built-in',
  );
});

test('reports invalid template placeholders before submitting a message', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-task-message-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'default.md');
  const context = {
    bindingId: 'proposer',
    signal: new AbortController().signal,
  };
  for (const [body, reason] of [
    ['{{round}}', /unknown variable "round"/],
    ['{{goal', /malformed placeholder/],
    ['   \n', /must not be empty/],
  ] as const) {
    await writeFile(file, body);
    await assert.rejects(
      renderTaskMessage(
        context,
        { default: file },
        'Built-in',
        { goal: 'Tune' },
        { name: 'diagnose-metrics', variables: { round: 3 } },
      ),
      (error: Error) =>
        error.message.includes('proposer.config.messageTemplates.default') &&
        error.message.includes(file) &&
        reason.test(error.message),
    );
  }
});

test('template paths resolve as binding resources with an explicit stage vocabulary', () => {
  const schema = {
    type: 'object',
    properties: {
      messageTemplates: messageTemplatesSchema('diagnose-metrics'),
    },
  };
  const config = { messageTemplates: { 'diagnose-metrics': './diagnose.md' } };
  validate(schema, config, 'config');
  assert.deepEqual(resolveConfig(config, tmpdir(), schema), {
    messageTemplates: { 'diagnose-metrics': join(tmpdir(), 'diagnose.md') },
  });
  assert.throws(
    () =>
      resolveConfig(
        {
          messageTemplates: {
            'diagnose-metrics': 'https://example.test/template.md',
          },
        },
        tmpdir(),
        schema,
      ),
    /messageTemplates.*diagnose-metrics.*local file path/,
  );
  assert.throws(
    () =>
      validate(
        schema,
        { messageTemplates: { typo: './diagnose.md' } },
        'config',
      ),
    /typo/,
  );
});
