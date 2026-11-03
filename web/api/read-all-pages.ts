import { readObservation, type Page } from './observation-client.js';
/** Assemble a complete bounded collection. Never publish the first page as a full chart. */
export async function readAllObservationPages<T>(
  path: string,
  parse: (raw: unknown) => Page<T>,
  signal?: AbortSignal,
): Promise<Page<T>> {
  const items: T[] = [];
  let offset = 0;
  let total: number | undefined;
  do {
    signal?.throwIfAborted();
    const separator = path.includes('?') ? '&' : '?';
    const page = await readObservation(
      `${path}${separator}offset=${offset}&limit=100`,
      parse,
      signal,
    );
    if (page.total > 5000)
      throw new Error(
        'This view supports up to 5,000 records. No partial collection is shown.',
      );
    if (total !== undefined && page.total !== total)
      throw new Error(
        'Records changed while loading. Refresh to load a complete chart.',
      );
    total = page.total;
    items.push(...page.items);
    if (page.nextOffset === null) break;
    if (page.nextOffset <= offset || page.nextOffset !== items.length)
      throw new Error('Invalid chart pagination response');
    offset = page.nextOffset;
  } while (true);
  if (items.length !== total)
    throw new Error('Incomplete chart data. Refresh to try again.');
  return { items, total, nextOffset: null };
}
