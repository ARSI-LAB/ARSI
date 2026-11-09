import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { evaluationFeedbackSchema } from '../../contracts/models/measurement.js';
import { json, object } from '../../shared/json.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../shared/schema.js';
import {
  configSchema,
  responsesSchema,
  type ScriptedAgentConfig,
  type ScriptedResponses,
} from './schema.js';

/** Match only normalized training feedback, never arbitrary diagnostic-looking text. */
function diagnosticCodes(request: AgentInput): Set<string> {
  const codes = new Set<string>();
  if (request.input === undefined) return codes;
  const input = object(request.input, 'agent.scripted input');
  if (input.evidence === undefined) return codes;
  const evidence = object(input.evidence, 'agent.scripted evidence');
  if (
    evidence.schemaVersion !== 'rsi.evidence-view/v1' ||
    evidence.view !== 'training-summary' ||
    !Array.isArray(evidence.measurements)
  )
    throw new Error('agent.scripted requires training-summary evidence');
  for (const rawMeasurement of evidence.measurements) {
    const measurement = object(rawMeasurement, 'training-summary Measurement');
    if (!Array.isArray(measurement.items))
      throw new Error('training-summary Measurement requires items');
    for (const rawItem of measurement.items) {
      const item = object(rawItem, 'training-summary item');
      if (item.evaluation === null) continue;
      const feedback = object(item.evaluation, 'training-summary evaluation');
      validate(
        evaluationFeedbackSchema,
        feedback,
        'training-summary evaluation',
      );
      if (!Array.isArray(feedback.diagnostics))
        throw new Error('training-summary evaluation requires diagnostics');
      for (const rawDiagnostic of feedback.diagnostics) {
        const code = object(rawDiagnostic).code;
        if (typeof code === 'string') codes.add(code);
      }
    }
  }
  return codes;
}

export const createScriptedAgent: OperationDefinition<
  AgentInput,
  AgentOutput,
  ScriptedAgentConfig
>['create'] = async (rawConfig, _services) => {
  const config = parseConfig<ScriptedAgentConfig>(
    configSchema,
    rawConfig,
    'agent.scripted config',
  );
  const raw: unknown = JSON.parse(await readFile(config.responses, 'utf8'));
  json(raw);
  const fixture = parseConfig<ScriptedResponses>(
    responsesSchema,
    raw,
    'agent.scripted responses',
  );
  return {
    async execute(request, context) {
      context.signal.throwIfAborted();
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      const source = request.files?.['input.py'];
      if (typeof source !== 'string')
        throw new Error('agent.scripted requires the supplied input.py source');
      const sourceDigest = createHash('sha256')
        .update(source, 'utf8')
        .digest('hex');
      const codes = diagnosticCodes(request);
      const matches = fixture.responses.filter(
        (entry) =>
          entry.sourceDigest === sourceDigest &&
          entry.requiredDiagnosticCodes.every((code) => codes.has(code)) &&
          (entry.excludedDiagnosticCodes ?? []).every(
            (code) => !codes.has(code),
          ),
      );
      if (matches.length !== 1)
        throw new Error(
          `agent.scripted matched ${matches.length} responses; expected exactly one for source ${sourceDigest}`,
        );
      const output = structuredClone(matches[0].response);
      validate(request.outputSchema, output, 'scripted Agent output');
      context.signal.throwIfAborted();
      return output;
    },
    async dispose() {},
  };
};
