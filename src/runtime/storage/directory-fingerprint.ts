import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Compare live snapshot trees, including empty directories and files omitted by artifact capture. */
export async function directoryFingerprint(root: string): Promise<string> {
  const digest = createHash('sha256');
  const visit = async (path: string, name: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() && !info.isFile())
      throw new Error('Unexpected linked or special snapshot entry: ' + path);
    const hash = info.isFile()
      ? createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      : null;
    digest.update(JSON.stringify([name, info.mode & 0o777, hash]) + '\n');
    if (info.isDirectory())
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name ? name + '/' + child : child);
  };
  await visit(root, '');
  return digest.digest('hex');
}
