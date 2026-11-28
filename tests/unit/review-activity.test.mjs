import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { command, observeReviewStart } from '../../.github/review/process.mjs';

test(
  'only the first model item starts a review, even across JSONL chunk boundaries',
  { timeout: 5000 },
  async (t) => {
    const stdout = new PassThrough();
    t.after(() => stdout.destroy());
    const first = Promise.withResolvers();
    let calls = 0;
    const observing = observeReviewStart(
      stdout,
      new AbortController().signal,
      () => {
        calls++;
        first.resolve();
      },
    );
    stdout.write(
      'diagnostic\n{"type":"thread.started"}\r\n{"type":"turn.started"}\n',
    );
    stdout.write(
      '{"type":"item.completed","item":{"type":"error","message":"agent_message"}}\n',
    );
    stdout.write('{"type":"item.st');
    await setImmediate();
    assert.equal(calls, 0);

    stdout.write('arted","item":{"type":"command_execution"}}\r\n');
    await first.promise;
    stdout.end('{"type":"item.completed","item":{"type":"agent_message"}}\n');
    await observing;
    assert.equal(calls, 1);
  },
);

test('process startup failures do not notify and notification failures propagate before cleanup', async () => {
  const launch = (source, onStarted) =>
    command(process.execPath, ['-e', source], {
      timeout: 10000,
      consumeStdout: (stdout, signal) =>
        observeReviewStart(stdout, signal, onStarted),
    });
  let calls = 0;
  await assert.rejects(
    launch(
      "console.log(JSON.stringify({type:'turn.failed',error:{message:'quota exceeded'}}));process.exitCode=1",
      () => calls++,
    ),
    /quota exceeded/,
  );
  assert.equal(calls, 0);

  const first = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finish = launch(
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message'}}))",
    async () => {
      first.resolve();
      await release.promise;
      throw new Error('review no longer eligible');
    },
  );
  const rejected = assert.rejects(finish, /review no longer eligible/);
  await first.promise;
  await setImmediate();
  release.resolve();
  await rejected;
});
