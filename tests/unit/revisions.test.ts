import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  RuntimeContext,
  parseFileTree,
  type Binding,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import {
  reflect,
  type ReflectionOptions,
} from '../../src/runtime/revisions/index.js';
import { RevisionApplication } from '../../src/runtime/revisions/application.js';
import {
  assignPointer,
  pointerValue,
} from '../../src/runtime/revisions/resources.js';
import { canonical, object, string } from '../../src/shared/json.js';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-revisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.rsi');
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const workspaces = new FileWorkspaces(
    join(directory, 'workspaces'),
    artifacts,
  );
  const bindings: Record<string, Binding> = {};
  for (const key of ['a', 'b']) {
    const guidance = join(root, key);
    await mkdir(guidance);
    await writeFile(join(guidance, 'initial.md'), `${key} original`);
    bindings[key] = { plugin: 'target', config: { guidance } };
  }
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    facts,
    artifacts,
    workspaces,
    signal: new AbortController().signal,
  });
  const definition: OperationDefinition = {
    id: 'target',
    contract: { id: 'contract.target', input_schema: {}, output_schema: {} },
    configSchema: {
      type: 'object',
      properties: { guidance: { type: 'string', 'x-rsi-path': 'directory' } },
    },
    create: async () => ({
      execute: async () => null,
      dispose: async () => {},
    }),
  };
  let number = 0;
  const observe = async (binding = 'a', extra: JsonObject = {}) => {
    const id = `call-${number++}`;
    await facts.write('calls', id, {
      callId: id,
      experimentId: context.experimentId,
      bindingId: binding,
      parentCallId: 'root',
      path: `loop/${number}/work`,
      status: 'succeeded',
      input: { taskId: 'task' },
      output: { rationale: 'one useful observation' },
      finishedAt: new Date().toISOString(),
      ...extra,
    });
    return id;
  };
  let generations = 0;
  const options: ReflectionOptions = {
    config: {
      path: join(root, 'reflection.yaml'),
      digest: 'config',
      evidence: ['a'],
      targets: {
        a: { resources: ['guidance'] },
        b: { resources: ['guidance'] },
      },
      goal: 'Improve guidance',
      implementation: {
        contract: 'contract.reflection',
        ref: 'custom',
        config: {},
      },
      budget: { modelCalls: 0 },
    },
    invocation: { policyScopeId: 'root', stepPath: 'init/improve' },
    generatorBinding: '_reflection',
    state: { wikiRef: 'must-not-read' },
    bindings,
    context,
    directory,
    revisionRefs: {},
    getDefinition: () => definition,
    invoke: async () => {
      generations++;
      return {
        status: 'no-change',
        proposal: null,
        reason: 'keep useful guidance',
      };
    },
    save: async (changes, revisions, activationId) => {
      Object.assign(bindings, changes);
      await facts.write('activations', context.experimentId, {
        activationId,
        revisions: { ...options.revisionRefs, ...revisions },
      });
    },
  };
  const proposed = async (
    input: JsonValue,
    edits: Record<string, string | null>,
  ): Promise<JsonValue> => {
    const value = object(input);
    const tree = parseFileTree(
      await artifacts.readJson(string(value.resourceRef)),
    );
    for (const [path, content] of Object.entries(edits)) {
      const file = tree.files.find((entry) => entry.path === path);
      if (content === null)
        tree.files = tree.files.filter((entry) => entry.path !== path);
      else if (file) file.base64 = Buffer.from(content).toString('base64');
      else
        tree.files.push({
          path,
          mode: process.platform === 'win32' ? 0o666 : 0o644,
          base64: Buffer.from(content).toString('base64'),
        });
    }
    return {
      status: 'proposed',
      proposal: {
        parentRevisionRefs: value.parentRevisionRefs!,
        resourceRef: await artifacts.putJson(tree),
        changeRef: 'change',
      },
      reason: 'bounded improvement',
    };
  };
  const next = (step: string): ReflectionOptions => ({
    ...options,
    invocation: { policyScopeId: 'root', stepPath: step },
  });
  return {
    root,
    directory,
    facts,
    artifacts,
    bindings,
    context,
    options,
    observe,
    proposed,
    next,
    generations: () => generations,
  };
}
test('resource pointers address configured collection entries and reject unsafe paths', () => {
  const config: JsonObject = { skills: ['original'] };
  assert.equal(pointerValue(config, '/skills/0'), 'original');
  assignPointer(config, '/skills/0', 'revision');
  assert.deepEqual(config.skills, ['revision']);
  assert.throws(() => assignPointer(config, '/skills/1', 'outside'), /missing/);
  assert.throws(() => pointerValue(config, '/__proto__/value'), /Unsafe/);
});
test(
  'show does not create probe files while a running Reflection captures its initial resources',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const guidance = string(f.bindings.a!.config.guidance);
    const prefix = 'bindings/a/resources/guidance';
    const savedFiles = ['a.md', 'b.md'].map((name) => ({
      path: `${prefix}/${name}`,
      mode: 0o644,
      base64: Buffer.from(name).toString('base64'),
    }));
    await f.facts.write('revisions', 'revision-inspect', {
      ref: 'revision-inspect',
      rootRef: 'revision-inspect',
      kind: 'initial',
      experimentId: 'finished-experiment',
      binding: 'a',
      policyScopeId: 'root',
      pluginRef: 'target',
      resourceRef: await f.artifacts.putJson({
        kind: 'file-tree',
        files: savedFiles,
      }),
      sourceResources: [
        {
          pointer: '/guidance',
          kind: 'directory',
          path: guidance,
          artifactPath: prefix,
        },
      ],
    });
    await f.facts.write('experiments', 'experiment', {
      id: 'experiment',
      status: 'running',
    });
    await f.observe();
    const app = new RevisionApplication({
      directory: f.directory,
      rootDirectory: f.root,
      facts: f.facts,
      artifacts: f.artifacts,
    });
    let captured!: () => void, resume!: () => void;
    const captureReady = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const captureAllowed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalCapture = f.artifacts.capture.bind(f.artifacts);
    f.artifacts.capture = async (...args) => {
      if (args[0] === guidance) {
        captured();
        await captureAllowed;
      }
      return originalCapture(...args);
    };
    const reflecting = reflect(f.options);
    const originalOpen = filesystem.open;
    let probes = 0;
    filesystem.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('.rsi-name-check-')) {
        probes++;
        // Reproduce capture during the probe's lifetime, before finally can clean it.
        resume();
        try {
          await reflecting;
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await captureReady;
      const shown = await app.show('revision-inspect');
      assert.equal(shown.applicationAllowed, false);
      assert.match(
        String(shown.restrictions),
        /Active or unresolved experiments: experiment/,
      );
      assert.deepEqual(shown.snapshot, savedFiles);
      resume();
      assert.equal((await reflecting).status, 'no-change');
      const initial = (await f.facts.list('revisions')).find(
        (revision) =>
          revision.experimentId === 'experiment' && revision.binding === 'a',
      );
      assert.ok(initial);
      const tree = parseFileTree(
        await f.artifacts.readJson(string(initial.resourceRef)),
      );
      assert.deepEqual(
        tree.files
          .filter((file) => file.path.startsWith(prefix + '/'))
          .map((file) => file.path),
        [`${prefix}/initial.md`],
      );
      assert.equal(probes, 0);
      assert.deepEqual(shown.changes, []);
    } finally {
      resume();
      await reflecting.catch(() => {});
      filesystem.open = originalOpen;
      syncBuiltinESMExports();
    }
  },
);
test('one observation without a Measurement invokes Reflection; no-change and empty windows retain initial snapshots', async (t) => {
  const f = await fixture(t);
  await f.observe();
  let seen: JsonObject = {};
  const result = await reflect({
    ...f.options,
    invoke: async (_binding, input) => {
      seen = object(input);
      assert.equal(Object.hasOwn(seen, 'memoryRef'), false);
      return { status: 'no-change', proposal: null, reason: 'adequate' };
    },
  });
  assert.equal(result.status, 'no-change');
  const revisions = await f.facts.list('revisions');
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    assert.equal(revision.kind, 'initial');
    assert.equal(revision.rootRef, revision.ref);
    assert.ok(typeof revision.resourceRef === 'string');
    assert.ok(Array.isArray(revision.sourceResources));
  }
  assert.equal((await reflect(f.next('second'))).status, 'skipped');
  assert.equal((await f.facts.list('revisions')).length, 2);
  await writeFile(
    join(f.root, 'a/initial.md'),
    'local edit after first snapshot',
  );
  await f.observe();
  const after = await reflect({
    ...f.next('third'),
    invoke: async (_binding, input) => {
      const tree = parseFileTree(
        await f.artifacts.readJson(string(object(input).resourceRef)),
      );
      const file = tree.files.find(
        (entry) => entry.path === 'bindings/a/resources/guidance/initial.md',
      )!;
      assert.equal(Buffer.from(file.base64, 'base64').toString(), 'a original');
      return {
        status: 'no-change',
        proposal: null,
        reason: 'snapshot retained',
      };
    },
  });
  assert.equal(after.status, 'no-change');
});
test('only changed targets gain revisions and activation preserves original sources and accumulated edits', async (t) => {
  const f = await fixture(t);
  await f.observe();
  const first = await reflect({
    ...f.options,
    invoke: async (_binding, input) =>
      f.proposed(input, {
        'bindings/a/resources/guidance/rules.md': 'first rule',
      }),
  });
  assert.equal(first.status, 'activated');
  assert.deepEqual(Object.keys(first.revisionRefs), ['a']);
  assert.equal((await f.facts.list('revisions')).length, 3);
  const unchanged = f.options.revisionRefs.b;
  assert.equal(
    await readFile(join(f.root, 'a/initial.md'), 'utf8'),
    'a original',
  );
  await assert.rejects(readFile(join(f.root, 'a/rules.md')), /ENOENT/);
  assert.equal(
    await readFile(
      join(string(f.bindings.a!.config.guidance), 'rules.md'),
      'utf8',
    ),
    'first rule',
  );
  await f.observe();
  const second = await reflect({
    ...f.next('second'),
    invoke: async (_binding, input) =>
      f.proposed(input, {
        'bindings/a/resources/guidance/second.md': 'second rule',
      }),
  });
  assert.equal(second.status, 'activated');
  assert.equal(f.options.revisionRefs.b, unchanged);
  const revision = await f.facts.read(
    'revisions',
    string(second.revisionRefs.a),
  );
  const root = await f.facts.read('revisions', string(revision.rootRef));
  assert.deepEqual(revision.sourceResources, root.sourceResources);
  assert.equal(
    await readFile(
      join(string(f.bindings.a!.config.guidance), 'rules.md'),
      'utf8',
    ),
    'first rule',
  );
  assert.equal(
    await readFile(
      join(string(f.bindings.a!.config.guidance), 'second.md'),
      'utf8',
    ),
    'second rule',
  );
});
test('local generator failures, invalid edits and budgets preserve activation; global exhaustion propagates', async (t) => {
  const f = await fixture(t);
  const cases: Array<[Record<string, string | null>, RegExp]> = [
    [{ 'bindings/a/resources/prompt': 'unauthorized' }, /outside authorized/],
    [{ 'bindings/a/resources/guidance/initial.md': null }, /delete denied/],
  ];
  for (const [index, [edits, expected]] of cases.entries()) {
    await f.observe();
    const result = await reflect({
      ...f.next(`invalid/${index}`),
      invoke: async (_binding, input) => f.proposed(input, edits),
    });
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, expected);
    assert.equal(
      (await f.facts.list('revisions')).filter(
        (revision) => revision.kind === 'generated',
      ).length,
      0,
    );
  }
  await f.observe();
  const failed = await reflect({
    ...f.next('failed'),
    invoke: async () => {
      throw new Error('local failure');
    },
  });
  assert.equal(failed.status, 'rejected');
  await f.observe();
  const zero = await reflect({
    ...f.next('zero'),
    config: {
      ...f.options.config,
      implementation: {
        ...f.options.config.implementation,
        ref: 'reflection.agent',
      },
    },
  });
  assert.equal(zero.status, 'rejected');
  assert.match(zero.reason, /model-call budget exhausted/);
  await f.observe();
  await assert.rejects(
    reflect({
      ...f.next('global'),
      invoke: async () => {
        const error = new Error('Budget exceeded: modelCalls');
        error.name = 'ExperimentBudgetExceeded';
        throw error;
      },
    }),
    /Budget exceeded/,
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled experiment'));
  await assert.rejects(
    reflect({
      ...f.next('cancelled'),
      context: f.context.extend({ signal: controller.signal }),
    }),
    /cancelled experiment/,
  );
});
test('Reflection accepts authorized edits beyond the former implicit file and byte limits', async (t) => {
  const f = await fixture(t);
  await f.observe();
  const result = await reflect({
    ...f.options,
    invoke: async (_binding, input) =>
      f.proposed(
        input,
        Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `bindings/a/resources/guidance/${index}.md`,
            'x'.repeat(index === 0 ? 131073 : 1),
          ]),
        ),
      ),
  });
  assert.equal(result.status, 'activated');
});
test('a prepared Reflection with legacy edit limits replays its original input', async (t) => {
  const f = await fixture(t);
  await f.observe();
  let prepared: JsonObject = {};
  const original = await reflect({
    ...f.options,
    invoke: async (_binding, _input, _key, scope) => {
      prepared = await f.facts.read('reflection', scope.id);
      return { status: 'no-change', proposal: null, reason: 'unchanged' };
    },
  });
  const tree = parseFileTree(
    await f.artifacts.readJson(string(prepared.resourceRef)),
  );
  const manifestFile = tree.files.find(
    (file) => file.path === 'manifest.json',
  )!;
  const manifest = object(
    JSON.parse(Buffer.from(manifestFile.base64, 'base64').toString('utf8')),
  );
  for (const entry of Object.values(manifest)) object(entry).maxBytes = 65536;
  manifestFile.base64 = Buffer.from(canonical(manifest)).toString('base64');
  const resourceRef = await f.artifacts.putJson(tree);
  const input = object(prepared.input);
  const legacyInput = {
    ...input,
    resourceRef,
    editConstraints: {
      ...object(input.editConstraints),
      maxChangedFiles: 16,
      maxChangedBytes: 131072,
    },
  };
  await f.facts.write('reflection', original.reflectionId, {
    ...prepared,
    resourceRef,
    input: legacyInput,
  });
  const recovered = await reflect({
    ...f.options,
    invoke: async (_binding, input) => {
      assert.deepEqual(input, legacyInput);
      return { status: 'no-change', proposal: null, reason: 'replayed' };
    },
  });
  assert.equal(recovered.reason, 'replayed');
});
test('prepared recovery reuses frozen evidence/resources and a committed activation does not regenerate or roll back', async (t) => {
  const f = await fixture(t);
  await f.observe();
  let prepared: JsonObject = {};
  let validated: JsonObject = {};
  let generations = 0;
  let fail = true;
  const options: ReflectionOptions = {
    ...f.options,
    invoke: async (_binding, input, _key, scope) => {
      generations++;
      prepared = await f.facts.read('reflection', scope.id);
      return f.proposed(input, {
        'bindings/a/resources/guidance/rules.md': 'saved rule',
      });
    },
    save: async (changes, revisions, id) => {
      validated = await f.facts.read('reflection', id);
      if (fail) throw new Error('preparation failed');
      await f.options.save(changes, revisions, id);
    },
  };
  const rejected = await reflect(options);
  assert.equal(rejected.status, 'rejected');
  assert.equal(validated.status, 'validated');
  await f.facts.write('reflection', rejected.reflectionId, validated);
  fail = false;
  const recovered = await reflect(options);
  assert.equal(recovered.status, 'activated');
  assert.equal(generations, 1);
  assert.deepEqual(await reflect(options), recovered);
  assert.equal(generations, 1);
  await f.facts.write('reflection', recovered.reflectionId, validated);
  assert.equal(
    (await reflect({ ...options, revisionRefs: {} })).status,
    'activated',
  );
  assert.equal(generations, 1);
  assert.ok(typeof prepared.evidenceViewRef === 'string');
  await assert.rejects(
    reflect({ ...options, config: { ...options.config, digest: 'changed' } }),
    /incompatible/,
  );
});
test('a later Policy invocation retains the binding resource owner and its generated snapshot remains applicable', async (t) => {
  const f = await fixture(t);
  await f.observe();
  await reflect({
    ...f.options,
    invoke: async (_binding, input) =>
      f.proposed(input, {
        'bindings/a/resources/guidance/first.md': 'first scope rule',
      }),
  });
  await f.observe('a', { parentCallId: 'child-scope' });
  const second = await reflect({
    ...f.options,
    invocation: { policyScopeId: 'child-scope', stepPath: 'improve' },
    invoke: async (_binding, input) =>
      f.proposed(input, {
        'bindings/a/resources/guidance/second.md': 'second scope rule',
      }),
  });
  assert.equal(second.status, 'activated');
  const application = new RevisionApplication({
    directory: f.directory,
    rootDirectory: f.root,
    facts: f.facts,
    artifacts: f.artifacts,
  });
  const shown = await application.show(string(second.revisionRefs.a));
  assert.equal(shown.reason, 'bounded improvement');
  assert.equal(shown.generationPolicyScopeId, 'child-scope');
  assert.equal(
    (await f.facts.read('reflection', second.reflectionId)).reason,
    'bounded improvement',
  );
  await application.apply(string(second.revisionRefs.a));
  assert.equal(
    await readFile(join(f.root, 'a/first.md'), 'utf8'),
    'first scope rule',
  );
  assert.equal(
    await readFile(join(f.root, 'a/second.md'), 'utf8'),
    'second scope rule',
  );
  assert.equal(
    await readFile(join(f.root, 'b/initial.md'), 'utf8'),
    'b original',
  );
});
test('resource preparation failure leaves existing revisions unchanged and publishes no phantom initial pointers', async (t) => {
  const f = await fixture(t);
  await f.observe();
  const unavailable = string(f.bindings.a!.config.guidance);
  await rm(unavailable, { recursive: true });
  const rejected = await reflect(f.options);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(f.options.revisionRefs, {});
  assert.deepEqual(await f.facts.list('revisions'), []);
  assert.equal(f.generations(), 0);
  await mkdir(unavailable);
  await writeFile(join(unavailable, 'initial.md'), 'restored original');
  await f.observe();
  assert.equal(
    (await reflect(f.next('after-source-recovery'))).status,
    'no-change',
  );
  const originalRevisions = { ...f.options.revisionRefs };
  assert.equal(Object.keys(originalRevisions).length, 2);
  for (const ref of Object.values(originalRevisions))
    assert.equal(
      (await f.facts.read('revisions', string(ref))).kind,
      'initial',
    );
  const failingContext = f.context.extend({
    artifacts: {
      putJson: f.artifacts.putJson.bind(f.artifacts),
      readJson: f.artifacts.readJson.bind(f.artifacts),
      materialize: f.artifacts.materialize.bind(f.artifacts),
      capture: async (): Promise<string> => {
        throw new Error('controlled snapshot I/O failure');
      },
    },
  });
  await f.observe();
  const later = await reflect({
    ...f.next('failed-later-preparation'),
    context: failingContext,
  });
  assert.equal(later.status, 'rejected');
  assert.deepEqual(f.options.revisionRefs, originalRevisions);
  assert.equal(f.generations(), 1);
});
test('a valid empty no-change reason replays from the terminal record without regeneration', async (t) => {
  const f = await fixture(t);
  await f.observe();
  let calls = 0;
  const options: ReflectionOptions = {
    ...f.options,
    invoke: async () => {
      calls++;
      return { status: 'no-change', proposal: null, reason: '' };
    },
  };
  const first = await reflect(options);
  assert.equal(first.status, 'no-change');
  assert.equal(first.reason, '');
  assert.deepEqual(await reflect(options), first);
  assert.equal(calls, 1);
});
