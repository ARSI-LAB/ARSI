import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { canonical } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { safePath } from '../shared/file-application/target.js';

export type ParameterDistribution =
  | {
      name: string;
      distribution: 'categorical';
      values: (string | number | boolean | null)[];
    }
  | {
      name: string;
      distribution: 'int' | 'float';
      low: number;
      high: number;
      step?: number;
      log?: boolean;
    };
type Sampler =
  | {
      type: 'tpe';
      seed?: number;
      options?: {
        startupTrials?: number;
        eiCandidates?: number;
        multivariate?: boolean;
      };
    }
  | { type: 'random'; seed?: number; options?: Record<string, never> };
export type OptunaConfig = {
  path: string;
  python?: { executable?: string; timeoutMs?: number };
  sampler: Sampler;
  constraintHandling?: 'native' | 'selection-only';
  maxSamplingAttempts?: number;
  searchSpace: ParameterDistribution[];
};
export type ResolvedOptunaConfig = OptunaConfig & {
  python: { executable: string; timeoutMs?: number };
  constraintHandling: 'native' | 'selection-only';
  maxSamplingAttempts?: number;
};
const integer = { type: 'integer', minimum: 1, maximum: 1000000 };
const name = { type: 'string', minLength: 1 };
const shape = (
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
export const configSchema: JsonSchema = shape(
  {
    path: name,
    python: shape(
      { executable: name, timeoutMs: { ...integer, maximum: 3600000 } },
      [],
    ),
    sampler: {
      oneOf: [
        shape(
          {
            type: { const: 'tpe' },
            seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
            options: shape(
              {
                startupTrials: { type: 'integer', minimum: 0, maximum: 1000 },
                eiCandidates: integer,
                multivariate: { type: 'boolean' },
              },
              [],
            ),
          },
          ['type'],
        ),
        shape(
          {
            type: { const: 'random' },
            seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
            options: shape({}),
          },
          ['type'],
        ),
      ],
    },
    constraintHandling: { enum: ['native', 'selection-only'] },
    maxSamplingAttempts: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    searchSpace: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        oneOf: [
          shape({
            name,
            distribution: { const: 'categorical' },
            values: {
              type: 'array',
              minItems: 1,
              maxItems: 10000,
              uniqueItems: true,
              items: { type: ['string', 'number', 'boolean', 'null'] },
            },
          }),
          shape(
            {
              name,
              distribution: { enum: ['int', 'float'] },
              low: { type: 'number' },
              high: { type: 'number' },
              step: { type: 'number', exclusiveMinimum: 0 },
              log: { type: 'boolean' },
            },
            ['name', 'distribution', 'low', 'high'],
          ),
        ],
      },
    },
  },
  ['path', 'sampler', 'searchSpace'],
);

function isStepAligned(
  value: number,
  low: number,
  step: number,
  integer: boolean,
): boolean {
  const position = (value - low) / step;
  if (!Number.isFinite(position)) return false;
  if (integer) return Math.abs(position - Math.round(position)) <= 1e-8;
  const nearest = low + Math.round(position) * step;
  // Compare in value units so small steps do not magnify rounding errors.
  const tolerance = Math.min(
    2 *
      Number.EPSILON *
      Math.max(Math.abs(value), Math.abs(low), Math.abs(nearest)),
    step / 4,
  );
  return Math.abs(value - nearest) <= tolerance;
}

export function parseOptunaConfig(value: unknown): ResolvedOptunaConfig {
  const raw = parseConfig<OptunaConfig>(configSchema, value, 'Optuna config');
  const path = safePath(raw.path);
  if (path.includes(':'))
    throw new Error('path must not contain a drive or alternate data stream');
  const names = new Set<string>();
  for (const axis of raw.searchSpace) {
    if (
      names.has(axis.name) ||
      ['__proto__', 'constructor', 'prototype'].includes(axis.name)
    )
      throw new Error(`searchSpace.${axis.name}: duplicate or forbidden name`);
    names.add(axis.name);
    if (axis.distribution === 'categorical') {
      // Optuna/Python compares bools and numbers as equal; reject ambiguous choices.
      const comparable = axis.values.map((v) =>
        canonical(typeof v === 'boolean' ? Number(v) : v),
      );
      if (new Set(comparable).size !== comparable.length)
        throw new Error(
          `searchSpace.${axis.name}: ambiguous categorical choices`,
        );
      continue;
    }
    const { low, high, step, log } = axis;
    if (
      low > high ||
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      !Number.isFinite(high - low)
    )
      throw new Error(`searchSpace.${axis.name}: invalid bounds`);
    if (
      axis.distribution === 'int' &&
      ![low, high, step ?? 1].every(Number.isSafeInteger)
    )
      throw new Error(`searchSpace.${axis.name}: expected safe integers`);
    if (
      log &&
      (low <= 0 ||
        (axis.distribution === 'float'
          ? step !== undefined
          : (step ?? 1) !== 1))
    )
      throw new Error(
        `searchSpace.${axis.name}: log requires positive bounds and compatible step`,
      );
    const increment = step ?? (axis.distribution === 'int' ? 1 : undefined);
    if (
      increment !== undefined &&
      !isStepAligned(high, low, increment, axis.distribution === 'int')
    )
      throw new Error(`searchSpace.${axis.name}: bounds must align with step`);
  }
  const sampler: Sampler =
    raw.sampler.type === 'tpe'
      ? {
          type: 'tpe',
          seed: raw.sampler.seed ?? 42,
          options: {
            startupTrials: 10,
            eiCandidates: 24,
            multivariate: false,
            ...raw.sampler.options,
          },
        }
      : { type: 'random', seed: raw.sampler.seed ?? 42, options: {} };
  const constraintHandling =
    raw.constraintHandling ??
    (sampler.type === 'tpe' ? 'native' : 'selection-only');
  if (sampler.type === 'random' && constraintHandling === 'native')
    throw new Error(
      'Random sampler does not support native constraints; use selection-only',
    );
  return {
    ...raw,
    path,
    sampler,
    python: { executable: 'python3', ...raw.python },
    constraintHandling,
    ...(raw.maxSamplingAttempts === undefined
      ? {}
      : { maxSamplingAttempts: raw.maxSamplingAttempts }),
  };
}

export function validateParameters(
  parameters: JsonObject,
  space: ParameterDistribution[],
): void {
  if (Object.keys(parameters).length !== space.length)
    throw new Error('Worker parameters do not match searchSpace');
  for (const axis of space) {
    const value = parameters[axis.name];
    if (axis.distribution === 'categorical') {
      if (!axis.values.some((v) => canonical(v) === canonical(value)))
        throw new Error(`Worker parameter ${axis.name} is outside searchSpace`);
    } else {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < axis.low ||
        value > axis.high ||
        (axis.distribution === 'int' && !Number.isSafeInteger(value))
      )
        throw new Error(`Worker parameter ${axis.name} is outside searchSpace`);
      const step = axis.step ?? (axis.distribution === 'int' ? 1 : undefined);
      if (
        step !== undefined &&
        !isStepAligned(value, axis.low, step, axis.distribution === 'int')
      )
        throw new Error(
          `Worker parameter ${axis.name} is not aligned with step`,
        );
    }
  }
}
