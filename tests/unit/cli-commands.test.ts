import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/entries/cli/commands.js';

test('CLI parses run options and repeatable global plugin directories', () => {
  assert.deepEqual(
    parseCommand([
      '--plugin-dir',
      'a',
      'run',
      'recipe.yaml',
      '--id=experiment',
      '--resume',
      '--plugin-dir',
      'b',
    ]),
    {
      command: 'run',
      args: ['recipe.yaml'],
      id: 'experiment',
      resume: true,
      pluginDirectories: ['a', 'b'],
    },
  );
});

test('CLI provides command-specific and nested help', () => {
  for (const args of [
    [],
    ['-h'],
    ['run', '-h'],
    ['reflection', '-h'],
    ['reflection', 'apply', '-h'],
    ['run', '--help'],
    ['help', 'run'],
    ['reflection', 'apply', '--help'],
  ]) {
    const result = parseCommand(args);
    assert.equal(result.command, 'help');
    assert.match(result.help ?? '', /Usage:/);
    if (args.includes('run')) assert.match(result.help ?? '', /--resume/);
    if (args.includes('apply')) assert.match(result.help ?? '', /revisionID/);
  }
});

test('CLI rejects invalid input before runtime initialization', () => {
  for (const args of [
    ['run'],
    ['run', 'r', '--resume'],
    ['show', 'id', 'extra'],
    ['catalog', '--bad'],
    ['list', 'bad'],
    ['reflection', 'apply'],
    ['dashboard', '--port', '0'],
    ['--plugin-dir'],
    ['serve'],
    ['unknown'],
  ]) {
    assert.throws(() => parseCommand(args));
  }
});

test('CLI maps existing commands and defaults to execution inputs', () => {
  for (const args of [
    ['validate', 'r.yaml'],
    ['show', 'exp'],
    ['cancel', 'exp'],
    ['list'],
    ['list', 'policies'],
    ['catalog'],
    ['dashboard'],
    ['reflection', 'list'],
    ['reflection', 'list', 'exp'],
    ['reflection', 'show', 'rev'],
    ['reflection', 'apply', 'rev'],
  ]) {
    const result = parseCommand(args);
    assert.equal(result.command, args[0]);
    assert.deepEqual(result.args, args.slice(1));
  }
  assert.equal(parseCommand(['dashboard']).port, 4317);
  assert.equal(parseCommand(['dashboard', '--port=65535']).port, 65535);
  assert.equal(parseCommand(['run', 'r.yaml']).resume, false);
});

test('CLI usage errors include focused help like evaluator', () => {
  for (const args of [
    ['run'],
    ['run', 'r.yaml', '--resume'],
    ['dashboard', '--port', '0'],
  ]) {
    assert.throws(
      () => parseCommand(args),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'helpText' in error);
        assert.match(
          String(error.helpText),
          new RegExp('Usage: ember-rsi ' + args[0]),
        );
        return true;
      },
    );
  }
});
