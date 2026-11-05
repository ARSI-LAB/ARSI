/** Freeze an owned JSON snapshot, including its nested arrays and objects. */
export function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeSnapshot(nested);
    Object.freeze(value);
  }
  return value;
}
