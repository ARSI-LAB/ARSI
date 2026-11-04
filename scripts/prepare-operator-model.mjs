#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Inventory an already deployed model; model/revision names are supplied by its owner. */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      'model-directory': { type: 'string' },
      'model-id': { type: 'string' },
      revision: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/prepare-operator-model.mjs --model-directory <deployed-weights> --model-id <id> --revision <immutable-revision> --out <new-identity.json>\nNo weights are downloaded. The output inventories exact bytes; it does not establish model compatibility.\n',
    );
    return 0;
  }
  for (const field of ['model-directory', 'model-id', 'revision', 'out'])
    if (!values[field]?.trim()) throw new Error(`Supply --${field}`);
  const directory = resolve(values['model-directory']),
    output = resolve(values.out),
    files = [];
  if (!(await lstat(directory)).isDirectory())
    throw new Error(
      'Model directory must be an ordinary directory, without symlinks',
    );
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const path = resolve(current, name);
      if (path === output) continue;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        files.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: hash.digest('hex'),
        });
        if (files.length > 10000)
          throw new Error('Model identity supports at most 10000 files');
      } else
        throw new Error(
          `Model identity rejects symlinks and nonordinary files: ${path}`,
        );
    }
  }
  await visit(directory);
  if (!files.length) throw new Error('Model directory is empty');
  const identity = {
    schemaVersion: 'rsi.operator-embedding-identity/v1',
    model: { id: values['model-id'], revision: values.revision },
    encoding: {
      queryPromptName: 'query',
      normalizeEmbeddings: true,
      device: 'cpu',
      batchSize: 32,
    },
    files,
  };
  const bytes = JSON.stringify(identity, null, 2) + '\n';
  await writeFile(output, bytes, { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      identityFile: output,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      files: files.length,
    }) + '\n',
  );
  return 0;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
