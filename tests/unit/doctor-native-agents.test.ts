import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/runtime/context.js';
import type { DoctorContext } from '../../src/contracts/index.js';

const flags =
  '--json --permission-mode --approval-policy --print --output-format --json-schema --tools --permission-prompts --strict-mcp-config --verbose --no-session-persistence --disallowedTools --mcp-config --settings';

for (const pluginId of ['agent.dsh', 'agent.claudecode']) {
  test(`${pluginId} doctor checks the CLI without claiming model access`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-doctor-'));
    const runtime = await createRuntime({
      homeDirectory: false,
      rootDirectory: root,
    });
    t.after(async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const executable = join(root, 'cli.cjs');
    const binding = {
      name: 'agent',
      pluginId,
      definition: runtime.registry.get(pluginId),
      config: { executable },
    };
    const controller = new AbortController();
    const context: DoctorContext = {
      binding,
      recipe: {
        application: binding,
        bindings: { agent: binding },
        policyConfig: {},
      },
      registry: runtime.registry,
      runtime: runtime.context,
      directory: root,
      signal: controller.signal,
    };
    const args =
      pluginId === 'agent.dsh'
        ? ['--profile', 'headless', '--help']
        : ['--help'];
    await writeFile(
      executable,
      `const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('--dump-config')) console.log('- id: fixture');
else if (args.includes('auth')) { assert.deepEqual(args, ['auth', 'status', args.includes('--help') ? '--help' : '--json']); console.log(args.includes('--help') ? '--json' : JSON.stringify({loggedIn:true})); }
else { assert.deepEqual(args, ${JSON.stringify(args)}); console.log(${JSON.stringify(flags)}); }`,
    );
    const diagnose = () =>
      runtime.registry.dispatch(pluginId, 'rsi/doctor', context);
    let report = await diagnose();
    assert.deepEqual(
      report.checks.map((c) => c.status),
      pluginId === 'agent.dsh'
        ? ['passed', 'passed', 'unchecked', 'unchecked']
        : ['passed', 'unchecked', 'passed', 'unchecked'],
    );

    const nativeArgs = pluginId === 'agent.dsh' ? '--dump-config' : '--json';
    for (const output of [
      'invalid-native-secret',
      pluginId === 'agent.dsh' ? '[]' : '{"loggedIn":false}',
    ]) {
      await writeFile(
        executable,
        `const args = process.argv.slice(2); if (args.includes(${JSON.stringify(nativeArgs)})) { console.log(${JSON.stringify(output)}); process.exit(${pluginId === 'agent.dsh' ? 0 : 1}); } console.log(${JSON.stringify(flags)});`,
      );
      report = await diagnose();
      assert.equal(
        report.checks.find(
          (check) =>
            check.id ===
            (pluginId === 'agent.dsh' ? 'profile-config' : 'authentication'),
        )?.status,
        'failed',
      );
      assert.ok(!JSON.stringify(report).includes('invalid-native-secret'));
      assert.equal(report.checks.at(-1)?.status, 'unchecked');
    }

    await writeFile(executable, 'console.log("--permission-mode");');
    report = await diagnose();
    assert.equal(report.checks[0].status, 'failed');
    assert.match(report.checks[0].reason ?? '', /required CLI options/);

    await writeFile(
      executable,
      'console.error("private-native-secret"); process.exit(1);',
    );
    report = await diagnose();
    assert.equal(report.checks[0].status, 'failed');
    assert.ok(!JSON.stringify(report).includes('private-native-secret'));

    await rm(executable);
    report = await diagnose();
    assert.equal(report.checks[0].status, 'failed');

    if (process.platform !== 'win32') {
      const target = join(root, 'native-bin');
      await writeFile(target, `#!/bin/sh\nprintf '%s\\n' '${flags}'\n`);
      await chmod(target, 0o755);
      const link = join(root, 'native-link');
      await symlink(target, link);
      binding.config.executable = link;
      report = await diagnose();
      assert.equal(report.checks[0].status, 'passed');
    }
    controller.abort();
    await assert.rejects(diagnose());
  });
}
