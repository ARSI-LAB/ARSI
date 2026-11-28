import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkArchitecture } from '../../scripts/check-architecture.mjs';

test('architecture checks module boundaries, public layout, and the exact shrinking exception set', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arsi-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, text = 'export {};\n') {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  write('package.json', '{"type":"module"}');
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        baseUrl: '.',
        paths: {
          '@contracts/*': ['src/contracts/*'],
          '@runtime/*': ['src/runtime/*'],
        },
      },
    }),
  );
  write(
    'tsconfig.web.json',
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' },
    }),
  );
  for (const plugin of ['proposer-agent', 'other']) {
    for (const module of ['index', 'schema', 'service'])
      write('src/plugins/' + plugin + '/' + module + '.ts');
  }
  write(
    'src/contracts/model.ts',
    "import './value.js';\nimport '../shared/standard.js';\nimport 'node:fs';",
  );
  write('src/contracts/value.ts');
  write('src/shared/standard.ts');
  write('src/runtime/storage/index.ts');
  write('src/shared/agent-project.ts');
  write('src/runtime/services/facts/evidence-packets.ts');
  write(
    'src/plugins/proposer-agent/execution-context.ts',
    "import '../../runtime/services/facts/evidence-packets.js';",
  );
  write(
    'src/plugins/shared/agent-editing/index.ts',
    "import '../../../runtime/storage/index.js';",
  );
  write(
    'src/plugins/shared/agent-editing/project.ts',
    [
      "import '../../../shared/agent-project.js';",
      "import '../../../runtime/storage/index.js';",
    ].join('\n'),
  );
  write(
    'src/plugins/proposer-agent/service.ts',
    [
      "import { value } from '../shared/agent-editing/index.js';",
      "import './schema.js';",
      "import '@contracts/value.js';",
      "// import '../other/index.js';",
    ].join('\n'),
  );
  write(
    'src/runtime/builtins.ts',
    "export * from '../plugins/proposer-agent/index.js';",
  );
  write(
    'src/runtime/manager.ts',
    "import '../plugins/shared/agent-editing/index.js';",
  );
  write('src/entries/cli.ts', "import '../runtime/manager.js';");
  write('web/view.tsx', "import '@contracts/value.js';");
  write('examples/demo.ts');
  assert.deepEqual(checkArchitecture(root), []);

  write(
    'src/contracts/model.ts',
    [
      "import type { Storage } from '@runtime/storage/index.js';",
      "export * from '../plugins/proposer-agent/index.js';",
      "type Mode = import('../entries/cli.js').Mode;",
      "await import('../../web/view.js');",
      "require('../../examples/demo.js');",
    ].join('\n'),
  );
  write(
    'src/runtime/manager.ts',
    "import other = require('../plugins/other/index.js');",
  );
  write(
    'web/view.tsx',
    [
      "import '../src/plugins/proposer-agent/index.js';",
      "import('@runtime/storage/index.js');",
      "export { cli } from '../src/entries/cli.js';",
      "import '../examples/demo.js';",
    ].join('\n'),
  );
  write(
    'src/plugins/other/service.ts',
    [
      "import '../proposer-agent/index.js';",
      "import '../../runtime/storage/index.js';",
    ].join('\n'),
  );
  write('src/plugins/shared/helper.mjs', "import '../other/service.js';");
  write(
    'src/plugins/proposer-agent/execution-context.ts',
    [
      "import '../../runtime/services/facts/evidence-packets.js';",
      "import '../../runtime/storage/index.js';",
    ].join('\n'),
  );
  write(
    'src/plugins/shared/agent-editing/project.ts',
    "import '../../../shared/agent-project.js';",
  );
  mkdirSync(path.join(root, 'src/plugins/incomplete'));
  const errors = checkArchitecture(root);
  const expected = [
    ['src/contracts/model.ts', 1, 'src/runtime/storage/index.ts'],
    ['src/contracts/model.ts', 2, 'src/plugins/proposer-agent/index.ts'],
    ['src/contracts/model.ts', 3, 'src/entries/cli.ts'],
    ['src/contracts/model.ts', 4, 'web/view.tsx'],
    ['src/contracts/model.ts', 5, 'examples/demo.ts'],
    ['src/runtime/manager.ts', 1, 'src/plugins/other/index.ts'],
    ['web/view.tsx', 1, 'src/plugins/proposer-agent/index.ts'],
    ['web/view.tsx', 2, 'src/runtime/storage/index.ts'],
    ['web/view.tsx', 3, 'src/entries/cli.ts'],
    ['web/view.tsx', 4, 'examples/demo.ts'],
    ['src/plugins/other/service.ts', 1, 'src/plugins/proposer-agent/index.ts'],
    ['src/plugins/other/service.ts', 2, 'src/runtime/storage/index.ts'],
    ['src/plugins/shared/helper.mjs', 1, 'src/plugins/other/service.ts'],
    [
      'src/plugins/proposer-agent/execution-context.ts',
      2,
      'src/runtime/storage/index.ts',
    ],
  ];
  for (const [file, line, dependency] of expected) {
    assert.ok(
      errors.some((message) =>
        message.startsWith(file + ':' + line + ': ' + dependency + ':'),
      ),
      errors.join('\n'),
    );
  }
  for (const name of ['index.ts', 'schema.ts', 'service.ts']) {
    assert.ok(
      errors.some((message) =>
        message.startsWith(
          'src/plugins/incomplete/' + name + ':1: Public plugin layout',
        ),
      ),
    );
  }
  assert.ok(
    errors.some(
      (message) =>
        message.startsWith('src/plugins/shared/agent-editing/project.ts:1:') &&
        message.includes('Delete this stale edge'),
    ),
  );
  assert.equal(errors.length, expected.length + 4);
});
