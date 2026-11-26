export const shellBuiltins = ['help', 'log-level', 'clear', 'exit'] as const;
type ShellBuiltin = (typeof shellBuiltins)[number];

export const shellHelp = [
  'help [command]  Show CLI help',
  'log-level [level|category=level]  Show or change the log level',
  'clear  Clear the terminal',
  'exit  Leave the shell',
].join('\n');

type ShellLine =
  | { kind: 'empty' }
  | { kind: 'command'; argv: string[] }
  | { kind: 'builtin'; name: ShellBuiltin; args: string[] };

// Tokenize one line of interactive input into argv for Commander to parse ordinary CLI commands.
export function splitCommandLine(line: string): string[] {
  const argv: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\' && quote !== "'") {
      const start = index;
      while (line[index + 1] === '\\') index++;
      const count = index - start + 1;
      const next = line[index + 1];
      if (next === '"') {
        word += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) word += '"';
        else quote = quote ? undefined : '"';
        index++;
      } else if (
        !quote &&
        next !== undefined &&
        (/\s/.test(next) || next === "'")
      ) {
        word += '\\'.repeat(count - 1) + next;
        index++;
      } else word += '\\'.repeat(count);
    } else if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (started) argv.push(word);
      word = '';
      started = false;
      continue;
    } else {
      word += char;
    }
    started = true;
  }
  if (quote)
    throw new Error(`Unclosed ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) argv.push(word);
  return argv;
}

export function parseShellLine(line: string): ShellLine {
  const tokens = splitCommandLine(line);
  const argv = tokens[0] === 'arsi' ? tokens.slice(1) : tokens;
  const [first, ...args] = argv;
  if (first === undefined) return { kind: 'empty' };
  const name = shellBuiltins.find((entry) => entry === first);
  return name ? { kind: 'builtin', name, args } : { kind: 'command', argv };
}
