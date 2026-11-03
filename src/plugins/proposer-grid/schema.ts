import type { JsonSchema, JsonValue } from '../../contracts/index.js';

export type GridProposerConfig = {
  path: string;
  searchSpace: { name: string; values: JsonValue[] }[];
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1 },
    searchSpace: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          values: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: true,
          },
        },
        required: ['name', 'values'],
      },
    },
  },
  required: ['path', 'searchSpace'],
};
