import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGraph } from '../../web/features/experiments/candidate-graph.js';
import {
  fileEntries,
  parentDirectory,
  parseArtifactFiles,
} from '../../web/features/experiments/file-browser-model.js';
import { readAllObservationPages } from '../../web/api/read-all-pages.js';
import { route, parseRoute } from '../../web/app/routing.js';
import type { CandidateSummary } from '../../web/api/observation-client.js';

const candidate = (
  ref: string,
  parentRef: string | null = null,
): CandidateSummary => ({ ref, parentRef, artifactRef: `artifact:${ref}` });

test('candidate graph keeps forks, disconnected roots and exact recorded edges without mutating input', () => {
  const records = [
    candidate('a'),
    candidate('b', 'a'),
    candidate('c', 'a'),
    candidate('d', 'b'),
    candidate('e'),
  ];
  const before = structuredClone(records);
  const graph = candidateGraph(records);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.cyclic, false);
  assert.deepEqual(graph.edges, [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'd' },
  ]);
  const nodes = new Map(graph.nodes.map((node) => [node.ref, node]));
  assert.ok(nodes.get('d')!.x > nodes.get('b')!.x);
  assert.ok(nodes.get('b')!.x > nodes.get('a')!.x);
  assert.notEqual(nodes.get('b')!.y, nodes.get('c')!.y);
  assert.equal(
    new Set(graph.nodes.map((node) => `${node.x}:${node.y}`)).size,
    5,
  );
  assert.deepEqual(records, before);
});

test('graph bounds retain selection and distinguish missing parents from undisplayed records; cycles terminate', () => {
  const records = [
    candidate('a'),
    candidate('b', 'a'),
    candidate('c', 'b'),
    candidate('d', 'missing'),
  ];
  const graph = candidateGraph(records, 'c', 2);
  assert.equal(graph.shown, 2);
  assert.equal(graph.total, 4);
  assert.ok(graph.nodes.some((node) => node.ref === 'c' && !node.missing));
  assert.ok(
    graph.nodes.some(
      (node) => node.ref === 'b' && node.missing && node.outside,
    ),
  );
  const orphan = candidateGraph(records);
  assert.ok(
    orphan.nodes.some(
      (node) => node.ref === 'missing' && node.missing && !node.outside,
    ),
  );
  const cycles = candidateGraph([
    candidate('a', 'b'),
    candidate('b', 'a'),
    candidate('c', 'a'),
    candidate('self', 'self'),
  ]);
  assert.equal(cycles.cyclic, true);
  assert.equal(cycles.edges.length, 4);
  assert.ok(
    cycles.nodes.every(
      (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
    ),
  );
  assert.equal(candidateGraph([]).nodes.length, 0);
});

test('file browsing uses directory segments, keeps full paths and searches outside the current directory', () => {
  const files = [
    { path: 'a/one.md', bytes: 10 },
    { path: 'a/nested/two.md', bytes: 20 },
    { path: 'ab/other.txt', bytes: 5 },
    { path: 'root.yaml', bytes: 1 },
  ];
  const before = structuredClone(files);
  assert.deepEqual(
    fileEntries(files, 'a', '').map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'nested', kind: 'directory' },
      { name: 'one.md', kind: 'file' },
    ],
  );
  assert.deepEqual(
    fileEntries(files, 'a', 'OTHER').map((item) => item.path),
    ['ab/other.txt'],
  );
  assert.equal(fileEntries(files, 'missing', '').length, 0);
  assert.equal(
    fileEntries(files, '', '').find((item) => item.path === 'a')?.files,
    2,
  );
  assert.equal(parentDirectory('a/nested/two.md'), 'a/nested');
  assert.equal(parentDirectory('root.yaml'), '');
  const file = '路径/a b&?#%.md';
  const parsed = parseRoute(
    route('experiment', 'results', 'candidate', 'artifact:ref', {
      file,
      directory: parentDirectory(file),
    }),
  );
  assert.equal(parsed.file, file);
  assert.equal(parsed.directory, '路径');
  assert.equal(parsed.candidate, 'candidate');
  assert.equal(parsed.artifact, 'artifact:ref');
  assert.deepEqual(files, before);
});

test('file index assembles every API page before directory/search results are exposed', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const files = Array.from({ length: 121 }, (_, index) => ({
    path: `folder/${index}.md`,
    bytes: index,
  }));
  const offsets: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    return new Response(
      JSON.stringify({
        ref: 'artifact:example',
        kind: 'file-tree',
        content: null,
        unavailable: null,
        files: {
          items: files.slice(offset, offset + 100),
          total: files.length,
          nextOffset: offset === 0 ? 100 : null,
        },
      }),
    );
  };
  const page = await readAllObservationPages(
    '/example/artifacts/ref',
    parseArtifactFiles,
  );
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(page.items.length, 121);
  assert.equal(fileEntries(page.items, '', '120.md')[0]?.path, 'folder/120.md');
});
