import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
async function diagnosticCodes(request: AgentInput): Promise<Set<string>> {
  const codes = new Set<string>();
  const evidence: unknown = JSON.parse(
    await readFile(join(request.cwd, 'context/measurements.json'), 'utf8'),
  );
  if (evidence === undefined || evidence === null) return codes;
  const view = object(evidence, 'agent.scripted evidence');
  if (
    view.schemaVersion !== 'rsi.evidence-view/v1' ||
    view.view !== 'training-summary' ||
    !Array.isArray(view.measurements)
  )
    throw new Error('agent.scripted requires training-summary evidence');
  for (const rawMeasurement of view.measurements) {
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
      // The proposer workspace carries editable files under candidate/ and
      // read-only shadowed files at their own paths; accept both layouts.
      let source: string;
      try {
        source = await readFile(
          join(request.cwd, 'candidate/input.py'),
          'utf8',
        );
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
        source = await readFile(join(request.cwd, 'input.py'), 'utf8');
      }
      const sourceDigest = createHash('sha256')
        .update(source, 'utf8')
        .digest('hex');
      const codes = await diagnosticCodes(request);
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
