import test from 'node:test';
import { RuntimeContext } from '../../src/contracts/index.js';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Candidate,
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { createFileApplication } from '../../src/plugins/shared/file-application/files.js';
import { gridProposerDefinition } from '../../src/plugins/proposer-grid/index.js';
import { gridProposerContract } from '../../src/contracts/plugin-types/proposer-grid.js';
import type { GridProposerConfig } from '../../src/plugins/proposer-grid/schema.js';
import { parseConfig, validate } from '../../src/shared/schema.js';
import { canonical, object, string } from '../../src/shared/json.js';

for (const mode of ['values', 'json', 'sixteen'] as const) {
  test(`grid ${mode} enumerates lazily with an explicit cursor, preserves JSON fields and releases edit workspaces`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-grid-'));
    try {
      const baseline = join(root, 'baseline');
      await mkdir(baseline);
      await writeFile(
        join(baseline, 'tuning.json'),
        mode === 'json'
          ? '{"a":{"second":2,"first":1},"b":false,"c":null,"fixed":true}\n'
          : '{"a":0.1,"b":1,"fixed":true}\n',
      );
      const artifacts = new FileArtifacts(join(root, 'artifacts'));
      const workspaces = new FileWorkspaces(
        join(root, 'workspaces'),
        artifacts,
      );
      const candidates = new Map<string, Candidate>();
      const unused = async (): Promise<never> => {
        throw new Error('Unexpected service');
      };
      const services: RuntimeContext = new RuntimeContext().extend({
        rootDirectory: root,
        dataDirectory: root,
        artifacts,
        workspaces,
        facts: new FileFacts(join(root, 'facts')),
        async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
          const ref = `c${candidates.size}`;
          candidates.set(ref, {
            ref,
            artifactRef,
            parentRef,
            experimentId: this.experimentId,
          });
          return ref;
        },
        async readCandidate(ref) {
          const candidate = candidates.get(ref);
          if (!candidate) throw new Error('Missing candidate');
          return candidate;
        },
        application: unused,
        applicationMetadata: unused,
        invoke: unused,
        readMeasurement: unused,
        recordMeasurement: unused,
        invokeAgent: unused,
        readEvidence: unused,
        withInstance: unused,
        charge: async () => {},
      });
      const context = services.extend({
        experimentId: 'grid',
        callId: 'call',
        bindingId: 'grid',
        idempotencyKey: 'call',
        directory: root,
        signal: new AbortController().signal,
        cleanup: new AbortController().signal,
      });
      const app = await createFileApplication(
        {
          target: {
            schema: {
              schemaVersion: 'rsi.target/v1',
              id: 'grid',
              entries: [
                {
                  path: 'tuning.json',
                  kind: 'file',
                  description: 'parameters',
                  changes: ['modify'],
                },
              ],
            },
          },
          baseline: { directory: baseline },
        },
        services,
        {
          capability: 'test',
          verify: async () => ({}),
          acquire: async () => ({}),
          release: async () => {},
          dispose: async () => {},
        },
      );
      services.application = function (this: RuntimeContext, input) {
        if (input.action !== 'commit')
          throw new Error('Unexpected Application action');
        return app.execute(
          {
            action: 'commit',
            parentCandidateRef: string(input.parentCandidateRef),
            editRef: string(input.editRef),
          },
          this,
        );
      };
      const initial = await app.execute({ action: 'initialize' }, context);
      assert.equal(initial.action, 'initialize');
      if (initial.action !== 'initialize')
        throw new Error('Unexpected initialization');
      const config: GridProposerConfig = {
        path: 'tuning.json',
        searchSpace: [
          { name: 'b', values: [1, 2] },
          { name: 'a', values: [0.1, 0.2, 0.3] },
        ],
      };
      if (mode === 'json')
        config.searchSpace = [
          { name: 'b', values: [false, 'auto'] },
          { name: 'a', values: [{ first: 1, second: 2 }, [1, 'fp8']] },
          { name: 'c', values: [null, true] },
        ];
      if (mode === 'sixteen')
        config.searchSpace = [
          { name: 'b', values: [32, 4, 16, 1] },
          { name: 'a', values: [2048, 4096, 8192, 16384] },
        ];
      const proposer = await gridProposerDefinition.create(config, services);
      const expected: JsonObject[] = [
        { a: 0.1, b: 1 },
        { a: 0.2, b: 1 },
        { a: 0.3, b: 1 },
        { a: 0.1, b: 2 },
        { a: 0.2, b: 2 },
        { a: 0.3, b: 2 },
      ];
      if (mode === 'sixteen')
        expected.splice(
          0,
          expected.length,
          ...[32, 4, 16, 1].flatMap((b) =>
            [2048, 4096, 8192, 16384].map((a) => ({ a, b })),
          ),
        );
      if (mode === 'json')
        expected.splice(
          0,
          expected.length,
          { b: false, a: { first: 1, second: 2 }, c: null },
          { b: false, a: { first: 1, second: 2 }, c: true },
          { b: false, a: [1, 'fp8'], c: null },
          { b: false, a: [1, 'fp8'], c: true },
          { b: 'auto', a: { first: 1, second: 2 }, c: null },
          { b: 'auto', a: { first: 1, second: 2 }, c: true },
          { b: 'auto', a: [1, 'fp8'], c: null },
          { b: 'auto', a: [1, 'fp8'], c: true },
        );
      for (let cursor = 0; cursor < expected.length; cursor++) {
        const output = await proposer.execute(
          { parent: initial.initialCandidateRef, cursor },
          context,
        );
        validate(gridProposerContract.output_schema, output);
        assert.equal(output.status, 'candidate');
        if (output.status !== 'candidate')
          throw new Error('Unexpected exhaustion');
        if (cursor === 0 && mode !== 'sixteen')
          assert.equal(output.candidateRef, initial.initialCandidateRef);
        assert.deepEqual(output.parameters, expected[cursor]);
        assert.equal(output.nextCursor, cursor + 1);
        assert.equal(output.totalCandidates, expected.length);
        const candidate = await context.readCandidate(output.candidateRef);
        const snapshot = join(root, `snapshot-${cursor}`);
        await artifacts.materialize(candidate.artifactRef, snapshot);
        assert.deepEqual(
          JSON.parse(await readFile(join(snapshot, 'tuning.json'), 'utf8')),
          { ...expected[cursor], fixed: true },
        );
      }
      const restored = await gridProposerDefinition.create(
        parseConfig<GridProposerConfig>(
          gridProposerDefinition.configSchema,
          JSON.parse(canonical(config)),
        ),
        services,
      );
      const resumed = await restored.execute(
        { parent: initial.initialCandidateRef, cursor: 3 },
        context,
      );
      assert.equal(resumed.status, 'candidate');
      if (resumed.status === 'candidate')
        assert.deepEqual(resumed.parameters, expected[3]);
      assert.deepEqual(
        await restored.execute(
          { parent: initial.initialCandidateRef, cursor: expected.length },
          context,
        ),
        {
          status: 'exhausted',
          nextCursor: expected.length,
          totalCandidates: expected.length,
        },
      );
      assert.deepEqual(await readdir(join(root, 'workspaces')), []);
      await assert.rejects(
        restored.execute(
          { parent: initial.initialCandidateRef, cursor: -1 },
          context,
        ),
        /cursor/,
      );
      services.application = async () => {
        throw new Error('Commit rejected');
      };
      await assert.rejects(
        restored.execute(
          { parent: initial.initialCandidateRef, cursor: 1 },
          context,
        ),
        /Commit rejected/,
      );
      assert.deepEqual(await readdir(join(root, 'workspaces')), []);
      assert.equal(
        object(
          JSON.parse(await readFile(join(baseline, 'tuning.json'), 'utf8')),
        ).fixed,
        true,
      );
      assert.ok(string(initial.initialCandidateRef));
      await app.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('grid rejects invalid spaces and unsafe paths before allocating resources', async () => {
  const definition: OperationDefinition = gridProposerDefinition;
  const configs: JsonObject[] = [
    {
      path: '../escape.json',
      searchSpace: [{ name: 'x', values: [1, 2] }],
    },
    {
      path: 'tuning.json:stream',
      searchSpace: [{ name: 'x', values: [1, 2] }],
    },
    { path: 'tuning.json', searchSpace: [] },
    {
      path: 'tuning.json',
      searchSpace: [
        { name: 'x', values: [1, 2] },
        { name: 'x', values: [1, 2] },
      ],
    },
    {
      path: 'tuning.json',
      searchSpace: [{ name: '__proto__', values: [1, 2] }],
    },
  ];
  for (const config of configs) {
    await assert.rejects(
      definition.create(config, new RuntimeContext()),
      /path|searchSpace|step|cardinality|max/,
    );
  }
});

test('grid rejects invalid JSON choices and obsolete interval fields', async () => {
  const definition: OperationDefinition = gridProposerDefinition;
  const invalidAxes: JsonObject[] = [
    { name: 'x', values: [] },
    { name: 'x', values: [1, 1] },
    {
      name: 'x',
      values: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    },
    {
      name: 'x',
      values: [
        [1, false],
        [1, false],
      ],
    },
    { name: 'x', values: [JSON.parse('{"constructor":1}')] },
    { name: 'x', min: 1, max: 2, step: 1 },
    { name: 'x', values: [Infinity] },
    { name: 'x', values: [NaN] },
    { name: 'x', values: [1], min: 1, max: 2, step: 1 },
    { name: 'x', values: [1], min: 1 },
  ];
  for (const axis of invalidAxes)
    await assert.rejects(
      definition.create(
        { path: 'tuning.json', searchSpace: [axis] },
        new RuntimeContext(),
      ),
      /searchSpace|values|number|finite JSON|Forbidden|additional properties/,
    );
});

test('grid supports large spaces when their cursors are safe integers', async () => {
  const context = new RuntimeContext().extend({
    signal: new AbortController().signal,
  });
  const searchSpace = Array.from({ length: 53 }, (_, index) => ({
    name: `axis_${index}`,
    values: [0, 1],
  }));
  const path = 'tuning.json';
  const totalCandidates = 2 ** 52;
  const proposer = await gridProposerDefinition.create(
    { path, searchSpace: searchSpace.slice(0, -1) },
    context,
  );
  try {
    assert.deepEqual(
      await proposer.execute(
        { parent: 'baseline', cursor: totalCandidates },
        context,
      ),
      { status: 'exhausted', nextCursor: totalCandidates, totalCandidates },
    );
  } finally {
    await proposer.dispose();
  }
  await assert.rejects(
    gridProposerDefinition.create({ path, searchSpace }, context),
    /cardinality/,
  );
});
