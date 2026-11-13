import type { JsonObject } from '../../../contracts/index.js';
import type { GymPublisher } from './schema.js';

const ENVIRONMENT_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandGymEnvironment(
  value: string,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(ENVIRONMENT_REFERENCE, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined)
      throw new Error(
        `gym ${field} references missing environment variable ${name}`,
      );
    return replacement;
  });
}

export function resolveGymPublisher(
  publisher: GymPublisher | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GymPublisher | undefined {
  if (publisher === undefined) return undefined;
  return expandPublisherValue(publisher, 'publish', environment);
}

/**
 * Expand every string in a publisher declaration. This keeps the shared config
 * layer independent of publisher kinds: adding a harness publisher does not
 * require another switch case here.
 */
function expandPublisherValue<T>(
  value: T,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): T {
  if (typeof value === 'string')
    return expandGymEnvironment(value, field, environment) as T;
  if (Array.isArray(value))
    return value.map((entry, index) =>
      expandPublisherValue(entry, `${field}[${index}]`, environment),
    ) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        expandPublisherValue(entry, `${field}.${key}`, environment),
      ]),
    ) as T;
  return value;
}

/** @deprecated Use resolveGymPublisher. */
export const resolveGymActivation = resolveGymPublisher;

/**
 * Publisher identity used by submission/release fingerprints. `bundleKinds`
 * is a local fail-fast guard and must not invalidate an existing Gym run.
 */
export function gymPublisherFingerprint(
  publisher: GymPublisher | undefined,
): JsonObject | null {
  if (publisher === undefined) return null;
  const identity = { ...publisher } as JsonObject & {
    bundleKinds?: string[];
  };
  delete identity.bundleKinds;
  return identity;
}
