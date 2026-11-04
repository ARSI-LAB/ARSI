import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export type HardwareContext = { text: string; sha256: string };

/** Read the full user document; values are context, never implicit hardware defaults. */
export async function readHardwareContext(
  path: string,
): Promise<HardwareContext> {
  if (typeof path !== 'string' || path.trim() === '')
    throw new Error('hardwareContextFile must be a nonempty file path');
  let bytes: Buffer;
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error('expected an ordinary file without symlinks');
    if ((stat.mode & 0o444) === 0) throw new Error('file is not readable');
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(
      `hardwareContextFile could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new Error('hardwareContextFile must contain valid UTF-8 text', {
      cause: error,
    });
  }
  if (text.trim() === '')
    throw new Error('hardwareContextFile must not be empty');
  return { text, sha256: createHash('sha256').update(bytes).digest('hex') };
}
