import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';

test('Doctor native protocol exchanges messages before closing stdin', async () => {
  const lines: string[] = [];
  const result = await runCommand(
    process.execPath,
    [
      '-e',
      `const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const value = JSON.parse(line);
  console.log(JSON.stringify({ id: value.id, answer: value.id === 1 ? 'ready' : 'complete' }));
});`,
    ],
    {
      signal: AbortSignal.timeout(5000),
      input: '{"id":1}\n',
      onLine(line, send) {
        lines.push(line);
        const value = JSON.parse(line);
        if (value.id === 1) send({ id: 2 });
        else return true;
      },
    },
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).answer),
    ['ready', 'complete'],
  );
  assert.equal(result.stdout, lines.join('\n') + '\n');
});

test('Doctor native protocol cleans up when its response handler fails', async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', "console.log('invalid'); setInterval(() => {}, 1000)"],
      {
        signal: AbortSignal.timeout(5000),
        onLine() {
          throw new Error('Invalid native response');
        },
      },
    ),
    /Invalid native response/,
  );
});

test('Doctor native protocol preserves split Unicode and an unterminated final line', async () => {
  const lines: string[] = [];
  await runCommand(
    process.execPath,
    [
      '-e',
      `const text = Buffer.from('{"answer":"沙箱"}');
process.stdout.write(text.subarray(0, 12));
setTimeout(() => process.stdout.end(text.subarray(12)), 10);`,
    ],
    {
      signal: AbortSignal.timeout(5000),
      async onLine(line) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        lines.push(line);
      },
    },
  );
  assert.deepEqual(lines, ['{"answer":"沙箱"}']);
});
