import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type ApplicationInput =
  | { action: 'initialize' }
  | {
      action: 'commit';
      parentCandidateRef: string;
      editRef: string;
      editConstraints?: JsonObject;
    }
  | {
      action: 'acquire';
      candidateRef: string;
      instanceId: string;
      capability: string;
    }
  | { action: 'release'; instanceId: string };

export type ApplicationOutput =
  | {
      action: 'initialize';
      initialCandidateRef: string;
      target: JsonObject;
      capabilities: string[];
      capabilityMetadata?: JsonObject;
    }
  | {
      action: 'commit';
      status: 'created' | 'no-change';
      candidateRef: string;
      diffRef: string | null;
    }
  | { action: 'acquire'; instanceId: string; execution: JsonObject }
  | { action: 'release'; instanceId: string; status: 'released' };

export const applicationContract = defineContract({
  id: 'contract.application',
  input_schema: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          action: { const: 'initialize' },
        },
        required: ['action'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'commit' },
          editConstraints: { type: 'object' },
          editRef: { minLength: 1, type: 'string' },
          parentCandidateRef: { minLength: 1, type: 'string' },
        },
        required: ['action', 'parentCandidateRef', 'editRef'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'acquire' },
          candidateRef: { minLength: 1, type: 'string' },
          capability: { minLength: 1, type: 'string' },
          instanceId: { minLength: 1, type: 'string' },
        },
        required: ['action', 'candidateRef', 'instanceId', 'capability'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'release' },
          instanceId: { minLength: 1, type: 'string' },
        },
        required: ['action', 'instanceId'],
        type: 'object',
      },
    ],
  },
  output_schema: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          action: { const: 'initialize' },
          capabilities: {
            items: { minLength: 1, type: 'string' },
            type: 'array',
          },
          capabilityMetadata: { type: 'object' },
          initialCandidateRef: { minLength: 1, type: 'string' },
          target: { type: 'object' },
        },
        required: ['action', 'initialCandidateRef', 'target', 'capabilities'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'commit' },
          candidateRef: { minLength: 1, type: 'string' },
          diffRef: { type: ['string', 'null'] },
          status: { enum: ['created', 'no-change'] },
        },
        required: ['action', 'status', 'candidateRef', 'diffRef'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'acquire' },
          execution: { type: 'object' },
          instanceId: { minLength: 1, type: 'string' },
        },
        required: ['action', 'instanceId', 'execution'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          action: { const: 'release' },
          instanceId: { minLength: 1, type: 'string' },
          status: { const: 'released' },
        },
        required: ['action', 'instanceId', 'status'],
        type: 'object',
      },
    ],
  },
});
