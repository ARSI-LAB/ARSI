import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../../src/shared/errors.js';

test('error diagnostics retain causes and nested native parallel failures', () => {
  const error = new Error('Event handling failed: rsi/call-succeeded', {
    cause: new AggregateError([
      new Error('first listener failed'),
      new AggregateError([new Error('second listener failed')]),
    ]),
  });
  assert.equal(
    errorText(error),
    'Event handling failed: rsi/call-succeeded; cause: first listener failed; second listener failed',
  );
  assert.equal(errorText(new AggregateError([])), 'AggregateError');
  assert.equal(errorText('non-Error rejection'), 'non-Error rejection');
});

test('error diagnostics redact credentials after composing every nested message', () => {
  const key = 'RSI_TEST_DIAGNOSTICS_SECRET';
  const previous = process.env[key];
  const credential = 'test-credential-that-must-never-persist';
  process.env[key] = credential;
  try {
    const error = new AggregateError(
      [
        new Error(`listener used ${credential}`, {
          cause: `token ${credential}`,
        }),
      ],
      `failed with ${credential}`,
    );
    const result = errorText(error);
    assert.equal(result.includes(credential), false);
    assert.equal((result.match(/\[REDACTED\]/g) ?? []).length, 3);
    assert.ok(
      error.message.includes(credential),
      'formatting leaves original errors intact',
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('error diagnostics bound cyclic causes while preserving repeated independent failures', () => {
  const error = new Error('cyclic');
  error.cause = error;
  assert.equal(errorText(error), 'cyclic; cause: [circular error]');
  const failure = new Error('repeated');
  assert.equal(
    errorText(new AggregateError([failure, failure])),
    'repeated; repeated',
  );
  const aggregate = new AggregateError([]);
  aggregate.errors.push(aggregate);
  assert.equal(errorText(aggregate), '[circular error]');
});
