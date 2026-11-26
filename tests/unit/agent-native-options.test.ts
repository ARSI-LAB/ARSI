import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContract } from '../../src/contracts/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Binding } from '../../src/runtime/loaders/binding.js';
import { Registry } from '../../src/runtime/registry/index.js';

test('native Agent bindings accept argv and reject reserved options and removed fields', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);

  const resolve = (plugin: string, config: unknown) =>
    Binding.resolve({
      registry,
      name: 'agent',
      required: agentContract,
      override: { declaration: { plugin, config }, directory: '.' },
    });

  for (const [backend, options, rejected] of [
    [
      'codex',
      ['-c', 'model="named-model"'],
      [
        ['--listen=off'],
        ['-c', 'approval_policy="on-request"'],
        ['-cproject_root_markers=[]'],
        ['--config="features".multi_agent=false'],
        ['--disable', 'multi_agent'],
      ],
    ],
    [
      'claudecode',
      ['--model', 'sonnet', '--effort', 'low'],
      [['--output-format=text'], ['--input-format', 'stream-json'], ['-p']],
    ],
    [
      'dsh',
      ['--session-id', 'fixture'],
      [['--profile=web'], ['--patch', 'other.json'], ['--dump-config']],
    ],
    [
      'opencode',
      ['--model', 'provider/model#high'],
      [
        ['--format=json'],
        ['--server', 'http://localhost:8080'],
        ['--standalone'],
      ],
    ],
  ] as const) {
    const plugin = `agent.${backend}`;
    assert.deepEqual(resolve(plugin, { options }).config.options, options);
    for (const forbidden of [...rejected, ['--'], ['--help'], ['a\0b'], [1]]) {
      assert.throws(
        () => resolve(plugin, { options: forbidden }),
        /config.*options/,
      );
    }
    assert.throws(
      () => resolve(plugin, { model: 'obsolete' }),
      /config.*additional properties/,
    );
  }
});
