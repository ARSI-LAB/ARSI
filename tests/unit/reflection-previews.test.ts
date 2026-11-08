import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { prepareDocumentPreviews } from '../../src/plugins/reflection-agent/document-previews.js';
import { createReflectionAgent } from '../../src/plugins/reflection-agent/service.js';
import { object, string } from '../../src/shared/json.js';

async function workbookFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('Inputs');
  first.getCell('A1').value = 'source value';
  first.getCell('B1').value = 42;
  first.getCell('C1').value = true;
  first.getCell('A2').value = { formula: 'B1*2', result: 84 };
  first.getCell('B2').value = { formula: 'B1*3' };
  first.getCell('D2').value = { formula: 'B1>0', result: true };
  first.getCell('E2').value = { formula: '1/0', result: { error: '#DIV/0!' } };
  const second = workbook.addWorksheet('Other');
  second.getCell('A1').value = 'another worksheet';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('Reflection previews preserve Excel cell/formula state, Word extraction order and PDF pages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-document-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(directory);
  const contents = [
    { path: 'deliverable.xlsx', bytes: await workbookFixture() },
    {
      path: 'deliverable.docx',
      bytes: await readFile(
        new URL(
          '../fixtures/reflection/paragraphs-and-table.docx',
          import.meta.url,
        ),
      ),
    },
    {
      path: 'deliverable.pdf',
      bytes: await readFile(
        new URL('../fixtures/reflection/pages.pdf', import.meta.url),
      ),
    },
  ];
  const artifactRef = await artifacts.putJson({
    kind: 'file-tree',
    files: contents.map(({ path, bytes }) => ({
      path,
      mode: 420,
      base64: bytes.toString('base64'),
    })),
  });
  const files: JsonObject = {};
  const previews = await prepareDocumentPreviews({
    sources: contents.map(({ path }, index) => ({
      artifactRef,
      path,
      pointer: `/files/${index}`,
      access: 'delivery',
    })),
    files,
    artifacts,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    previews.map((preview) => preview.inspection),
    ['complete', 'complete', 'complete'],
  );
  const excel = string(files[string(previews[0]!.path)]);
  assert.match(excel, /Worksheet "Inputs"/);
  assert.match(excel, /Worksheet "Other"/);
  assert.match(excel, /A2 .*"formula":"B1\*2".*"savedResult":84/);
  assert.match(excel, /B2 .*"savedResultStatus":"missing"/);
  assert.match(excel, /C2 .*"type":"blank"/);
  assert.match(excel, /D2 .*"savedResult":true.*"savedResultType":"boolean"/);
  assert.match(
    excel,
    /E2 .*"savedResult":\{"error":"#DIV\/0!"\}.*"savedResultType":"error"/,
  );
  const word = string(files[string(previews[1]!.path)]);
  assert.ok(word.indexOf('Above') < word.indexOf('Top left'));
  assert.ok(word.indexOf('Bottom right') < word.indexOf('Below'));
  assert.match(word, /table:1 row:2 cell:2/);
  assert.doesNotMatch(JSON.stringify(previews[1]!.locations), /page/);
  const pdf = string(files[string(previews[2]!.path)]);
  assert.match(pdf, /Page 1\nFirst page/);
  assert.match(pdf, /Page 2\nSecond page/);
  assert.match(pdf, /Page 3\n\[No extractable text/);
  assert.equal(object(previews[2]!.source).artifactRef, artifactRef);
});

test('Word previews retain bullet, nested and numbered list items in document order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-word-lists-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(directory);
  const bytes = await readFile(
    new URL(
      '../fixtures/reflection/paragraphs-and-lists.docx',
      import.meta.url,
    ),
  );
  const artifactRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      { path: 'lists.docx', mode: 0o644, base64: bytes.toString('base64') },
    ],
  });
  const files: JsonObject = {};
  const [preview] = await prepareDocumentPreviews({
    sources: [{ artifactRef, path: 'lists.docx', access: 'delivery' }],
    files,
    artifacts,
    signal: new AbortController().signal,
  });
  assert.equal(preview!.inspection, 'complete');
  const content = string(files[string(preview!.path)]);
  assert.deepEqual(
    content
      .split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf('"')))),
    [
      'Opening paragraph',
      'Parent bullet',
      'Nested bullet',
      'Next bullet',
      'Between lists',
      'First numbered item',
      'Second numbered item',
      'Cell bullet one',
      'Cell bullet two',
      'Closing paragraph',
    ],
  );
  const locations = preview!.locations as JsonObject[];
  assert.equal(locations.length, 10);
  assert.equal(locations[2]!.listLevel, 2);
  assert.equal(locations[5]!.list, 'ordered');
  assert.equal(locations[6]!.item, 2);
  assert.equal(locations[7]!.table, 1);
  assert.equal(locations[7]!.cell, 1);
});

test('Reflection preview failures are explicit and do not hide other sources; existing text is reused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-preview-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(directory);
  const artifactRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'corrupt.docx',
        mode: process.platform === 'win32' ? 438 : 420,
        base64: Buffer.from('not a zip').toString('base64'),
      },
    ],
  });
  const files: JsonObject = {
    'context/existing.txt': 'Existing authorized readable text',
  };
  const sources: JsonObject[] = [
    {
      artifactRef,
      path: 'corrupt.docx',
      pointer: '/files/0',
      access: 'delivery',
    },
    { artifactRef, path: 'missing.xlsx', access: 'delivery' },
    { path: 'unsupported.xls', access: 'delivery' },
    { path: 'not-captured.pdf', access: 'delivery' },
    {
      artifactRef,
      path: 'readable.docx',
      access: 'delivery',
      textPath: 'context/existing.txt',
      locations: [{ paragraph: 2 }],
      truncated: true,
      omissions: ['The original readable text was truncated'],
    },
  ];
  const previews = await prepareDocumentPreviews({
    sources,
    files,
    artifacts,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    previews.map((preview) => preview.inspection),
    ['failed', 'unavailable', 'unsupported', 'unavailable', 'partial'],
  );
  assert.equal(previews[4]!.reusedText, true);
  assert.equal(previews[4]!.path, 'context/existing.txt');
  assert.deepEqual(previews[4]!.locations, [{ paragraph: 2 }]);
  assert.deepEqual(previews[4]!.omissions, [
    'The original readable text was truncated',
  ]);
  assert.doesNotMatch(JSON.stringify(previews), /stack|[A-Za-z]:\\/);
  await assert.rejects(
    prepareDocumentPreviews({
      sources: [{ ...sources[0], access: 'private' }],
      files: {},
      artifacts,
      signal: new AbortController().signal,
    }),
    /not authorized/,
  );
  await assert.rejects(
    prepareDocumentPreviews({
      sources: [{ ...sources[0], pointer: '/files/999' }],
      files: {},
      artifacts,
      signal: new AbortController().signal,
    }),
    /pointer/,
  );
  await assert.rejects(
    prepareDocumentPreviews({
      sources,
      files: {},
      artifacts,
      signal: AbortSignal.abort(new Error('cancel preview')),
    }),
    /cancel preview/,
  );
});

test('Reflection reuses empty readable text while preserving its inspection metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-empty-text-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files: JsonObject = { 'context/empty.txt': '' };
  const previews = await prepareDocumentPreviews({
    sources: [
      {
        path: 'empty.docx',
        access: 'delivery',
        textPath: 'context/empty.txt',
        locations: [{ paragraph: 1 }],
        inspection: 'partial',
        truncated: true,
        omissions: ['The readable source has no visible text'],
      },
    ],
    files,
    artifacts: new FileArtifacts(directory),
    signal: new AbortController().signal,
  });
  assert.equal(previews[0]!.inspection, 'partial');
  assert.equal(previews[0]!.reusedText, true);
  assert.equal(previews[0]!.truncated, true);
  assert.deepEqual(previews[0]!.locations, [{ paragraph: 1 }]);
  assert.deepEqual(previews[0]!.omissions, [
    'The readable source has no visible text',
  ]);
  assert.equal(files[string(previews[0]!.path)], '');
});

test('Reflection preserves an accepted empty workbook extraction as an empty readable preview', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rsi-empty-workbook-preview-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(directory);
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const artifactRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      { path: 'empty.xlsx', mode: 420, base64: bytes.toString('base64') },
    ],
  });
  const files: JsonObject = {};
  const previews = await prepareDocumentPreviews({
    sources: [
      {
        artifactRef,
        path: 'empty.xlsx',
        pointer: '/files/0',
        access: 'delivery',
      },
    ],
    files,
    artifacts,
    signal: new AbortController().signal,
  });
  assert.equal(previews[0]!.inspection, 'complete');
  assert.deepEqual(previews[0]!.locations, []);
  assert.deepEqual(previews[0]!.omissions, []);
  assert.equal(files[string(previews[0]!.path)], '');
});

test('Reflection previews redact extracted values and locations and report resource bounds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-preview-redaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = process.env.REFLECTION_PREVIEW_API_KEY;
  process.env.REFLECTION_PREVIEW_API_KEY = 'SYNTHETIC_PREVIEW_SECRET_1234';
  t.after(() => {
    if (prior === undefined) delete process.env.REFLECTION_PREVIEW_API_KEY;
    else process.env.REFLECTION_PREVIEW_API_KEY = prior;
  });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('SYNTHETIC_PREVIEW_SECRET_1234').getCell('A1').value =
    'SYNTHETIC_PREVIEW_SECRET_1234';
  const artifacts = new FileArtifacts(directory);
  const artifactRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'secrets.xlsx',
        mode: 420,
        base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString(
          'base64',
        ),
      },
      {
        path: 'oversized.pdf',
        mode: 420,
        base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
      },
    ],
  });
  const files: JsonObject = {};
  const previews = await prepareDocumentPreviews({
    sources: [
      { artifactRef, path: 'secrets.xlsx', access: 'delivery' },
      { artifactRef, path: 'oversized.pdf', access: 'delivery' },
    ],
    files,
    artifacts,
    signal: new AbortController().signal,
  });
  assert.doesNotMatch(
    JSON.stringify({ files, previews }),
    /SYNTHETIC_PREVIEW_SECRET_1234/,
  );
  assert.match(JSON.stringify({ files, previews }), /REDACTED/);
  assert.equal(previews[1]!.inspection, 'partial');
  assert.match(string(previews[1]!.reason), /input bound/);
});

test('Reflection supplies preview files in its workspace and rejects evidence edits and view changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-preview-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const facts = new FileFacts(join(directory, 'facts'));
  const workspaces = new FileWorkspaces(
    join(directory, 'workspaces'),
    artifacts,
  );
  const resourceRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'guidance.md',
        mode: process.platform === 'win32' ? 438 : 420,
        base64: Buffer.from('Original guidance').toString('base64'),
      },
    ],
  });
  const sourceRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'output.xlsx',
        mode: 420,
        base64: (await workbookFixture()).toString('base64'),
      },
    ],
  });
  const snapshot: JsonObject = {
    experimentId: 'preview',
    view: 'reflection-observations/v1',
    evidenceView: 'execution',
    files: { 'context/call.json': '{"status":"succeeded"}' },
    index: { callIds: ['call'] },
    sources: [
      {
        artifactRef: sourceRef,
        path: 'output.xlsx',
        pointer: '/files/0',
        access: 'delivery',
      },
    ],
  };
  await facts.write('evidence-views', 'evidence-preview', snapshot);
  let editEvidence = false;
  let reads = 0;
  const context = new RuntimeContext().extend({
    experimentId: 'preview',
    directory,
    artifacts,
    facts,
    workspaces,
    signal: new AbortController().signal,
    async invokeAgent(
      _binding: string,
      request: JsonObject,
    ): Promise<JsonObject> {
      const cwd = string(request.cwd);
      const index = JSON.parse(
        await readFile(join(cwd, 'context/reflection/index.json'), 'utf8'),
      );
      const preview = object(index.previews[0]);
      assert.match(
        await readFile(join(cwd, string(preview.path)), 'utf8'),
        /source value/,
      );
      reads++;
      return {
        edits: editEvidence
          ? [{ path: string(preview.path), content: 'not allowed' }]
          : [],
        reason: 'Inspected the preview',
      };
    },
  });
  const operation = await createReflectionAgent(
    { prompt: 'src/plugins/reflection-agent/prompt.md' },
    context,
  );
  const input = {
    parentRevisionRefs: { proposer: 'revision-initial' },
    resourceRef,
    goal: 'Improve guidance',
    evidenceRefs: ['evidence-preview'],
    editConstraints: { allowedPaths: ['guidance.md'] },
  };
  assert.equal((await operation.execute(input, context)).status, 'no-change');
  editEvidence = true;
  await assert.rejects(operation.execute(input, context), /read.only/);
  assert.equal(reads, 2);
  await facts.write('evidence-views', 'evidence-preview', {
    ...snapshot,
    evidenceView: 'training-summary',
  });
  await assert.rejects(
    operation.execute(input, context),
    /ownership or format/,
  );
});
