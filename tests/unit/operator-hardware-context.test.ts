import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function reader(path: string): Promise<{ text: string; sha256: string }> {
  const module: unknown = await import(
    new URL('../../src/plugins/proposer-operator/service.ts', import.meta.url)
      .href
  );
  assert.ok(module && typeof module === 'object');
  const fn: unknown = Reflect.get(module, 'readHardwareContext');
  assert.equal(typeof fn, 'function');
  if (typeof fn !== 'function') throw new Error('Missing hardware reader');
  const result: unknown = await fn(path);
  assert.ok(result && typeof result === 'object');
  const text: unknown = Reflect.get(result, 'text');
  const sha256: unknown = Reflect.get(result, 'sha256');
  assert.equal(typeof text, 'string');
  assert.equal(typeof sha256, 'string');
  if (typeof text !== 'string' || typeof sha256 !== 'string')
    throw new Error('Invalid hardware result');
  return { text, sha256 };
}

test('hardware context preserves the complete user text and hashes its original bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-hardware-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'hardware-context.md');
  const text =
    '\uFEFF# User hardware notes \u03bb\r\n\r\nCustom fields are allowed.  \r\n';
  await writeFile(path, text);
  const result = await reader(path);
  assert.equal(result.text, text);
  assert.equal(
    result.sha256,
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  );
});

test('hardware context rejects missing, blank, unreadable and non-file inputs with field context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-hardware-context-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    reader(join(root, 'missing.md')),
    /hardwareContextFile.*(read|exist|ENOENT)/i,
  );
  const blank = join(root, 'blank.md');
  await writeFile(blank, ' \r\n\t');
  await assert.rejects(reader(blank), /hardwareContextFile.*empty/i);
  const unreadable = join(root, 'unreadable.md');
  await writeFile(unreadable, 'private hardware');
  await chmod(unreadable, 0o000);
  // Containers with a DAC override can read this file despite its mode bits.
  const accessible = await readFile(unreadable).then(
    () => true,
    () => false,
  );
  if (accessible)
    assert.equal((await reader(unreadable)).text, 'private hardware');
  else await assert.rejects(reader(unreadable), /hardwareContextFile.*read/i);
  const directory = join(root, 'directory');
  await mkdir(directory);
  await assert.rejects(
    reader(directory),
    /hardwareContextFile.*(ordinary|file)/i,
  );
  const linked = join(root, 'linked.md');
  await symlink(blank, linked);
  await assert.rejects(
    reader(linked),
    /hardwareContextFile.*(ordinary|symlink|file)/i,
  );
  const invalid = join(root, 'invalid.md');
  await writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(reader(invalid), /hardwareContextFile.*UTF-8/i);
});
