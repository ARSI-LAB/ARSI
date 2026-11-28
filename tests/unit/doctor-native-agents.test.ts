import { diagnoseBinding } from '../../src/runtime/doctor/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/runtime/context.js';
import type { DoctorContext } from '../../src/contracts/index.js';
import { checkDshAgent } from '../../src/plugins/agent-dsh/doctor.js';
import { checkClaudeCodeAgent } from '../../src/plugins/agent-claudecode/doctor.js';
import { checkCodexAgent } from '../../src/plugins/agent-codex/doctor.js';
import { isNativeAgentCompatible } from '../../src/plugins/shared/doctor/native-agent.js';

const flags =
  '--json --permission-mode --approval-policy --print --input-format --output-format --json-schema --tools --permission-prompts --strict-mcp-config --verbose --no-session-persistence --disallowedTools --mcp-config --settings';

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
    const calls = join(root, 'calls');
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
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'called');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('2.1.248 (Claude Code)');
else if (args.includes('--dump-config')) console.log('- id: fixture');
else if (args.includes('auth')) { assert.deepEqual(args, ['auth', 'status', args.includes('--help') ? '--help' : '--json']); console.log(args.includes('--help') ? '--json' : JSON.stringify({loggedIn:true})); }
else { assert.deepEqual(args, ${JSON.stringify(args)}); console.log(${JSON.stringify(flags)}); }`,
    );
    const define =
      pluginId === 'agent.dsh' ? checkDshAgent : checkClaudeCodeAgent;
    assert.ok(Array.isArray(define(context)));
    assert.ok(Array.isArray(checkCodexAgent(context)));
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
    const diagnose = () => diagnoseBinding(runtime.registry, context);
    assert.equal(
      await isNativeAgentCompatible(
        context,
        pluginId === 'agent.dsh' ? 'dsh' : 'claude',
        args,
        ['--json'],
        context.signal,
      ),
      true,
    );
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
        `const args = process.argv.slice(2); if (args.includes('--version')) { console.log('2.1.248 (Claude Code)'); } else if (args.includes(${JSON.stringify(nativeArgs)})) { console.log(${JSON.stringify(output)}); process.exit(${pluginId === 'agent.dsh' ? 0 : 1}); } console.log(${JSON.stringify(flags)});`,
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
      assert.deepEqual(
        report.checks.map((check) => check.status),
        pluginId === 'agent.dsh'
          ? ['passed', 'failed', 'unchecked', 'unchecked']
          : ['passed', 'unchecked', 'failed', 'unchecked'],
      );
    }

    if (pluginId === 'agent.claudecode') {
      await writeFile(
        executable,
        `console.log(process.argv.includes('--version') ? '2.1.247 (Claude Code)' : ${JSON.stringify(flags)});`,
      );
      report = await diagnose();
      assert.equal(report.checks[0].status, 'failed');
      assert.match(report.checks[0].reason ?? '', /2\.1\.248/);
    }

    await writeFile(executable, 'console.log("--permission-mode");');
    assert.equal(
      await isNativeAgentCompatible(
        context,
        pluginId === 'agent.dsh' ? 'dsh' : 'claude',
        args,
        ['--json'],
        context.signal,
      ),
      false,
    );
    report = await diagnose();
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ['failed', 'unchecked', 'unchecked', 'unchecked'],
    );
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
      await writeFile(
        target,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '2.1.248'; else printf '%s\\n' '${flags}'; fi\n`,
      );
      await chmod(target, 0o755);
      const link = join(root, 'native-link');
      await symlink(target, link);
      binding.config.executable = link;
      report = await diagnose();
      assert.equal(
        report.checks.find((check) => check.status === 'failed')?.id,
        pluginId === 'agent.dsh' ? 'profile-config' : 'authentication',
      );
    }
    controller.abort();
    await assert.rejects(diagnose());
  });
}
