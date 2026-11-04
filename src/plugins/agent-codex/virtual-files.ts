import type { JsonObject } from '../../contracts/index.js';
import { string } from '../../shared/json.js';

export const readFileSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1 },
    startLine: { type: 'integer', minimum: 1 },
    lineCount: { type: 'integer', minimum: 1, maximum: 500 },
    byteOffset: { type: 'integer', minimum: 0 },
    maxBytes: { type: 'integer', minimum: 1024, maximum: 32768 },
  },
  required: ['path'],
};

/** Only this supplied snapshot is readable. Pagination also bounds a single huge JSON line. */
export function readVirtualFile(
  files: Record<string, string>,
  input: JsonObject,
): string {
  const path = string(input.path);
  if (path !== '.' && !Object.hasOwn(files, path))
    throw new Error('File is outside authorized snapshot');
  const content =
    path === '.' ? Object.keys(files).sort().join('\n') : files[path]!;
  const lines = content.split('\n');
  const start = Number(input.startLine ?? 1);
  const count = Number(input.lineCount ?? 200);
  if (start > lines.length)
    throw new Error('Line range starts past the virtual file');
  const endLine = Math.min(lines.length, start + count - 1);
  const bytes = Buffer.from(lines.slice(start - 1, endLine).join('\n'));
  const offset = Number(input.byteOffset ?? 0);
  const limit = Number(input.maxBytes ?? 16384);
  if (
    offset > bytes.length ||
    (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
  )
    throw new Error('Invalid virtual-file byte offset');
  let end = Math.min(bytes.length, offset + limit);
  const result = (): string =>
    JSON.stringify({
      path,
      startLine: start,
      endLine,
      totalLines: lines.length,
      byteOffset: offset,
      nextByteOffset: end < bytes.length ? end : null,
      rangeBytes: bytes.length,
      moreLines: endLine < lines.length,
      text: bytes.subarray(offset, end).toString('utf8'),
    });
  while (true) {
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80)
      end--;
    const output = result();
    if (Buffer.byteLength(output) <= limit) return output;
    if (end === offset)
      throw new Error('Virtual-file metadata exceeds byte limit');
    end = offset + Math.floor((end - offset) / 2);
  }
}
