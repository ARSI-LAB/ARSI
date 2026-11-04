import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { object, string } from '../../src/shared/json.js';

const directory = resolve(
  fileURLToPath(
    new URL('../../src/plugins/proposer-operator/', import.meta.url),
  ),
);

async function resource(path: string): Promise<Buffer> {
  assert.equal(isAbsolute(path), false);
  const resolved = resolve(directory, path);
  const local = relative(directory, resolved);
  assert.ok(local !== '..' && !local.startsWith(`..${sep}`));
  assert.equal((await lstat(resolved)).isFile(), true);
  for (let part = dirname(resolved); part !== directory; part = dirname(part)) {
    assert.equal((await lstat(part)).isSymbolicLink(), false);
  }
  const bytes = await readFile(resolved);
  const contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(contents.trim().length > 0);
  assert.equal(contents.includes('/home/'), false);
  assert.equal(contents.includes('~/'), false);
  return bytes;
}

test('operator resource manifest resolves every static technique and prompt inside the package with matching bytes', async () => {
  const manifest = object(
    JSON.parse((await resource('knowledge/manifest.json')).toString('utf8')),
  );
  assert.equal(manifest.schemaVersion, 'rsi.operator-knowledge/v1');
  const upstream = object(manifest.upstream);
  assert.equal(upstream.repository, 'ngo-agent');
  assert.equal(upstream.commit, 'e8bf53c0d9d70200d235c761f5e7472118b8e898');
  assert.ok(Array.isArray(manifest.resources));
  const paths = new Set<string>();
  for (const value of manifest.resources) {
    const entry = object(value);
    const path = string(entry.path);
    assert.equal(paths.has(path), false);
    paths.add(path);
    const bytes = await resource(path);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
    );
    const source = object(entry.source);
    assert.ok(string(source.path).startsWith('src/ngo_agent/'));
    assert.match(string(source.sha256), /^[0-9a-f]{64}$/);
    assert.ok(string(entry.adaptation));
  }
  for (const name of [
    'diagnose',
    'generate',
    'repair',
    'summarize',
    'triton-ascend-guidelines',
  ]) {
    assert.ok(paths.has(`prompts/${name}.md`));
  }
  assert.ok(Array.isArray(manifest.techniques));
  assert.deepEqual(
    manifest.techniques.map((value) => object(value).id).sort(),
    [
      'core_partition',
      'loop_invariant_hoisting',
      'masked_accumulator',
      'pass_merge',
    ],
  );
  for (const value of manifest.techniques) {
    const entry = object(value);
    const documentPath = string(entry.document);
    const examplePath = string(entry.example);
    assert.ok(paths.has(documentPath));
    assert.ok(paths.has(examplePath));
    const technique = object(
      JSON.parse((await resource(documentPath)).toString('utf8')),
    );
    assert.equal(technique.schemaVersion, 'rsi.operator-technique/v1');
    assert.equal(technique.id, entry.id);
    assert.equal(technique.example, examplePath);
    for (const field of ['name', 'matchText', 'content', 'sourceReference']) {
      assert.ok(string(technique[field]).trim().length > 0);
    }
    assert.match(string(technique.notice), /Copyright/);
    assert.match(string(technique.notice), /Apache/);
    assert.match((await resource(examplePath)).toString('utf8'), /Copyright/);
  }
});
