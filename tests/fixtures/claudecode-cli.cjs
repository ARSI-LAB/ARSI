const fs = require('node:fs');
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const spec = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
  const audit = {
    args: process.argv.slice(2),
    input: JSON.parse(input),
    pid: process.pid,
  };
  if (spec.hang) {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: 'inherit' },
    );
    audit.child = child.pid;
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  fs.writeFileSync('audit.json', JSON.stringify(audit));
  for (const event of spec.events ?? [])
    process.stdout.write(JSON.stringify(event) + '\n');
  if (spec.invalid) process.stdout.write('not-json\n');
  if (!spec.hang) process.exitCode = spec.exitCode ?? 0;
});
