import type { FactStore, JsonObject } from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';

/** A failed durable write must reach the Manager even when the business operation is optional. */
export class PersistenceError extends Error {
  constructor(cause: unknown) {
    super(errorText(cause), { cause });
  }
}

export async function persistFact(
  store: FactStore,
  kind: string,
  id: string,
  value: JsonObject,
): Promise<void> {
  try {
    await store.write(kind, id, value);
  } catch (error) {
    throw new PersistenceError(error);
  }
}
