import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContract } from '../../src/contracts/plugin-types/agent.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Binding } from '../../src/runtime/loaders/binding.js';
import { codexDefinition } from '../../src/plugins/agent-codex/index.js';
import { claudeCodeDefinition } from '../../src/plugins/agent-claudecode/index.js';
import { dshDefinition } from '../../src/plugins/agent-dsh/index.js';

for (const definition of [
  codexDefinition,
  claudeCodeDefinition,
  dshDefinition,
]) {
  test(`${definition.id} resolves Policy sandbox defaults and Recipe overrides`, async (t) => {
    const registry = new Registry();
    t.after(() => registry.dispose());
    registry.registerOperation(definition);
    const defaults = {
      declaration: {
        plugin: definition.id,
        config: { sandbox: 'read-only', timeoutMs: 1000 },
      },
      directory: '.',
    };
    const options = {
      name: 'agent',
      required: agentContract,
      registry,
      defaults,
    };
    assert.equal(Binding.resolve(options).config.sandbox, 'read-only');
    for (const sandbox of ['workspace-write', 'inherit']) {
      const binding = Binding.resolve({
        ...options,
        override: { declaration: { config: { sandbox } }, directory: '.' },
      });
      assert.equal(binding.config.sandbox, sandbox);
      assert.equal(binding.config.timeoutMs, 1000);
      assert.equal(binding.toJSON().config.sandbox, sandbox);
    }
    assert.throws(
      () =>
        Binding.resolve({
          ...options,
          override: {
            declaration: { config: { sandbox: 'danger-full-access' } },
            directory: '.',
          },
        }),
      /sandbox/,
    );
    const legacy = Binding.resolve({
      ...options,
      defaults: undefined,
      override: { declaration: { plugin: definition.id }, directory: '.' },
    });
    assert.equal(Object.hasOwn(legacy.toJSON().config, 'sandbox'), false);
  });
}

test('switching Agent plugins discards the previous sandbox configuration', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerOperation(codexDefinition);
  registry.registerOperation(dshDefinition);
  const binding = Binding.resolve({
    name: 'agent',
    required: agentContract,
    registry,
    defaults: {
      declaration: {
        plugin: 'agent.codex',
        config: { sandbox: 'read-only', thinkingLevel: 'high' },
      },
      directory: '.',
    },
    override: { declaration: { plugin: 'agent.dsh' }, directory: '.' },
  });
  assert.equal(binding.pluginId, 'agent.dsh');
  assert.equal(Object.hasOwn(binding.config, 'sandbox'), false);
  assert.equal(Object.hasOwn(binding.config, 'thinkingLevel'), false);
});
