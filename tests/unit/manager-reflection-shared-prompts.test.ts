import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  defineContract,
  parseFileTree,
  reflectionContract,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Manager activates shared prompt revisions for the affected consumers and applies both rounds together', (t) =>
  exerciseSharedPrompts(t, false));
test('Manager runs Reflection through a linked ancestor and can export the revision to an independent destination', (t) =>
  exerciseSharedPrompts(t, true));

async function exerciseSharedPrompts(t: TestContext, linked: boolean) {
  const temp = await mkdtemp(join(tmpdir(), 'rsi-shared-prompts-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  // The direct writeback and export destinations must have no linked ancestors, including macOS /var.
  const directory = await realpath(temp);
  const project = join(directory, 'project');
  await mkdir(project);
  const root = linked ? join(directory, 'alias') : project;
  if (linked)
    await symlink(
      project,
      root,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  const prompts = join(root, 'prompts');
  const task = join(root, 'task');
  const summary = join(prompts, 'summarize.md');
  await mkdir(prompts);
  await mkdir(task);
  await writeFile(join(prompts, 'diagnose.md'), 'original diagnosis');
  await writeFile(summary, 'original summary');
  await writeFile(join(task, 'benchmark.md'), 'unchanged benchmark');

  const proposerInstances: JsonObject[] = [];
  const summarizerInstances: JsonObject[] = [];
  const reader: OperationDefinition = {
    id: 'test.prompt-reader',
    contract: defineContract({
      id: 'contract.prompt-reader',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: {
      type: 'object',
      properties: {
        promptsDirectory: { type: 'string', 'x-rsi-path': 'directory' },
        taskDirectory: { type: 'string', 'x-rsi-path': 'directory' },
        promptFile: { type: 'string', 'x-rsi-path': 'file' },
      },
    },
    async create(config) {
      const directory = config.promptsDirectory;
      (directory ? proposerInstances : summarizerInstances).push(config);
      const file = directory
        ? join(string(directory), 'diagnose.md')
        : string(config.promptFile);
      return {
        execute: async () => ({ text: await readFile(file, 'utf8') }),
        dispose: async () => {},
      };
    },
  };
  const projection = 'resources/proposer/promptsDirectory';
  let round = 0;
  const reviser: OperationDefinition = {
    id: 'test.prompt-reviser',
    contract: reflectionContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, ctx) {
          round++;
          const request = object(input);
          const ref = string(request.resourceRef);
          const files = parseFileTree(await ctx.artifacts.readJson(ref)).files;
          assert.deepEqual(files.map((file) => file.path).sort(), [
            'manifest.json',
            projection + '/diagnose.md',
            projection + '/summarize.md',
          ]);
          const workspace = await ctx.workspaces.create(ref);
          try {
            const diagnosis = join(
              workspace.directory,
              projection,
              'diagnose.md',
            );
            if (round === 1) {
              assert.equal(
                await readFile(diagnosis, 'utf8'),
                'original diagnosis',
              );
              await writeFile(diagnosis, 'revised diagnosis');
            } else {
              assert.equal(
                await readFile(diagnosis, 'utf8'),
                'revised diagnosis',
              );
              await writeFile(
                join(workspace.directory, projection, 'summarize.md'),
                'revised summary',
              );
            }
            return {
              status: 'proposed',
              reason: 'Revise a prompt',
              proposal: {
                parentRevisionRefs: request.parentRevisionRefs!,
                resourceRef: await ctx.artifacts.capture(workspace.directory),
                changeRef: await ctx.artifacts.putJson({ round }),
              },
            };
          } finally {
            await ctx.workspaces.release(workspace.ref);
          }
        },
        dispose: async () => {},
      };
    },
  };
  const reflection = join(root, 'reflection.yaml');
  await writeFile(
    reflection,
    JSON.stringify({
      targets: {
        include: { proposer: ['promptsDirectory'], summarizer: ['promptFile'] },
      },
      implementation: { ref: reviser.id, config: {} },
    }),
  );
  const readBoth = [
    { type: 'invoke', id: 'diagnose', use: 'proposer', with: {} },
    { type: 'invoke', id: 'summarize', use: 'summarizer', with: {} },
  ];
  const fixture = await managerFixture(async () => ({}), {
    plugins: [reader, reviser],
    initialize: () =>
      writeFile(join(prompts, 'diagnose.md'), 'source edited after locking'),
    bindings: {
      proposer: {
        plugin: reader.id,
        config: { promptsDirectory: prompts, taskDirectory: task },
      },
      summarizer: { plugin: reader.id, config: { promptFile: summary } },
    },
    policy: {
      defaults: { reflection: { configFile: reflection } },
      steps: [
        { type: 'loop', id: 'search', maxIterations: 2, steps: readBoth },
        ...structuredClone(readBoth),
      ],
      output: {
        diagnosis: '${{ steps.diagnose.output.text }}',
        summary: '${{ steps.summarize.output.text }}',
      },
    },
  });
  t.after(() => fixture.dispose());
  const result = await fixture.run();
  assert.equal(result.status, 'succeeded');
  const runs = await fixture.manager.facts.list('evolution-runs');
  assert.ok(
    runs.every((run) => run.status === 'activated'),
    JSON.stringify(runs.map((run) => run.reason)),
  );
  assert.deepEqual(result.output, {
    diagnosis: 'revised diagnosis',
    summary: 'revised summary',
  });
  assert.equal(round, 2);
  assert.equal(proposerInstances.length, 3);
  assert.equal(summarizerInstances.length, 2);
  assert.notEqual(proposerInstances[0]!.promptsDirectory, prompts);
  assert.notEqual(summarizerInstances[0]!.promptFile, summary);
  assert.equal(
    join(string(proposerInstances[2]!.promptsDirectory), 'summarize.md'),
    summarizerInstances[1]!.promptFile,
  );
  assert.equal(
    new Set(proposerInstances.map((config) => config.taskDirectory)).size,
    1,
  );
  const revisions = await fixture.manager.reflection().list('test');
  assert.equal(revisions.length, 3);
  assert.deepEqual(
    revisions.map((revision) => revision.changedBindings),
    [['proposer', 'summarizer'], ['proposer'], []],
  );
  assert.equal(await readFile(summary, 'utf8'), 'original summary');
  const id = string(revisions[0]!.revisionID);
  const app = fixture.manager.reflection();
  const destination = linked ? join(directory, 'export') : prompts;
  if (linked) {
    const preview = await app.show(id);
    assert.equal(preview.applicationAllowed, false);
    await assert.rejects(app.apply(id), /Linked destination rejected/);
    assert.equal(
      await readFile(join(prompts, 'diagnose.md'), 'utf8'),
      'source edited after locking',
    );
    // Replacing the link with a regular directory must not redirect in-place publication.
    await unlink(root);
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, 'keep.md'), 'replacement content');
    await assert.rejects(app.apply(id), /changed its physical path/);
    assert.equal(
      await readFile(join(prompts, 'keep.md'), 'utf8'),
      'replacement content',
    );
  }
  assert.equal(
    (await app.apply(id, linked ? { to: destination } : {})).status,
    'applied',
  );
  assert.equal(
    await readFile(join(destination, 'diagnose.md'), 'utf8'),
    'revised diagnosis',
  );
  assert.equal(
    await readFile(join(destination, 'summarize.md'), 'utf8'),
    'revised summary',
  );
}
