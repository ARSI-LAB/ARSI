const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const patch = JSON.parse(
  fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'),
);
if (
  !args.includes('--json') ||
  !args.includes('never') ||
  !patch.some((row) => row.id === 'agent-instructions')
)
  process.exit(2);
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const task = JSON.parse(input.split('\n\n')[0]);
  const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  send({ type: 'session', sessionId: 'test-session' });
  if (task.goal === 'wait' || task.goal === 'background') {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    fs.writeFileSync('child.pid', String(child.pid));
    if (task.goal === 'wait') {
      setInterval(() => {}, 1000);
      return;
    }
    child.unref();
  }
  if (task.goal === 'malformed') {
    process.stdout.write('not-json\n');
    return;
  }
  if (task.goal === 'missing') return;
  if (task.goal === 'error') {
    send({ type: 'error', message: 'secret-do-not-log' });
    return;
  }
  send({
    type: 'status',
    phase: 'step_end',
    usage: { inputTokens: 12, outputTokens: 4 },
  });
  send({
    type: 'final',
    sessionId: 'test-session',
    reason: { kind: task.goal === 'aborted' ? 'aborted' : 'completed' },
    text: task.goal === 'invalid' ? '{"ok":"wrong"}' : '{"ok":true}',
  });
  if (task.goal === 'exit-failure') process.exitCode = 1;
});
