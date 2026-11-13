const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(process.env.RSI_TEST_OPENCODE_VERSION || 'opencode v2.2.7');
} else if (args.includes('--help')) {
  console.log('--standalone --format --agent --model --archived');
} else if (args[0] === 'debug') {
  console.log(
    JSON.stringify([
      {
        type: 'document',
        info: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
      },
    ]),
  );
} else {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const agent = args[args.indexOf('--agent') + 1];
  fs.writeFileSync(
    'audit.json',
    JSON.stringify({
      args,
      config,
      agent,
      pwd: process.env.PWD,
      cwd: process.cwd(),
    }),
  );
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const { goal } = JSON.parse(input);
    const emit = (type, part, sessionID = 'session') =>
      console.log(JSON.stringify({ type, sessionID, part }));
    if (goal === 'wait') {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
      );
      fs.writeFileSync('child.pid', String(child.pid));
      setInterval(() => {}, 1000);
      return;
    }
    if (goal === 'error') {
      console.log(
        JSON.stringify({
          type: 'error',
          error: { message: 'secret-native-key' },
        }),
      );
      return;
    }
    if (goal === 'malformed') return console.log('not json');
    emit('step_start', { messageID: 'intermediate' });
    emit('text', { messageID: 'intermediate', text: 'I will read the task.' });
    emit('step_finish', { messageID: 'intermediate', reason: 'tool-calls' });
    emit('step_start', { messageID: 'final' });
    emit('text', {
      messageID: 'final',
      text: goal === 'invalid' ? '{"ok":"wrong"}' : '{"ok":',
    });
    if (goal !== 'invalid')
      emit(
        'text',
        { messageID: 'final', text: 'true}' },
        goal === 'wrong-session' ? 'other' : 'session',
      );
    if (goal !== 'missing')
      emit('step_finish', {
        messageID: 'final',
        reason: goal === 'truncated' ? 'length' : 'stop',
        tokens: { input: 10, output: 3 },
      });
    if (goal === 'exit') process.exitCode = 1;
  });
}
