import type { JsonObject, JsonSchema } from '../../contracts/index.js';

export type ScriptedAgentConfig = {
  responses: string;
};

export type ScriptedResponse = {
  sourceDigest: string;
  requiredDiagnosticCodes: string[];
  excludedDiagnosticCodes?: string[];
  response: JsonObject;
};

export type ScriptedResponses = {
  schemaVersion: 'rsi.scripted-agent/v1';
  responses: ScriptedResponse[];
};

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    responses: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
  },
  required: ['responses'],
  additionalProperties: false,
};

const diagnosticCodes: JsonObject = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  uniqueItems: true,
};

export const responsesSchema: JsonSchema = {
  type: 'object',
  properties: {
    schemaVersion: { const: 'rsi.scripted-agent/v1' },
    responses: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          requiredDiagnosticCodes: diagnosticCodes,
          excludedDiagnosticCodes: diagnosticCodes,
          response: { type: 'object' },
        },
        required: ['sourceDigest', 'requiredDiagnosticCodes', 'response'],
        additionalProperties: false,
      },
    },
  },
  required: ['schemaVersion', 'responses'],
  additionalProperties: false,
};
