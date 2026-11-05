import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '../contracts/index.js';
/** Freeze an owned JSON snapshot iteratively, rejecting cycles; callers copy before handing over ownership. */
export function freezeSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const stack: { node: object; exit: boolean }[] = [
    { node: value, exit: false },
  ];
  while (stack.length) {
    const { node, exit } = stack.pop()!;
    if (exit) {
      Object.freeze(node);
      active.delete(node);
      completed.add(node);
      continue;
    }
    if (active.has(node)) throw new Error('Cannot freeze cyclic snapshot');
    if (completed.has(node)) continue;
    active.add(node);
    stack.push({ node, exit: true });
    const children: unknown[] = Object.values(node);
    for (const child of children.reverse())
      if (child !== null && typeof child === 'object')
        stack.push({ node: child, exit: false });
  }
  return value;
}
export function object(value: unknown, label = 'value'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  json(value);
  return value as JsonObject;
}
export function json(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(json);
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error(`Forbidden key ${key}`);
      json(entry);
    }
    return;
  }
  throw new Error('Expected finite JSON data');
}
export function string(value: unknown, label = 'value'): string {
  if (typeof value !== 'string' || !value.length)
    throw new Error(`${label}: expected non-empty string`);
  return value;
}
export function strings(value: unknown, label = 'value'): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  return value.map((v) => string(v, label));
}
export function canonical(value: unknown): string {
  json(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function unknownKeys(
  value: JsonObject,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${label}: unknown field ${key}`);
}
