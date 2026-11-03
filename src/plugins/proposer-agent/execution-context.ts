import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { json, object, string } from '../../shared/json.js';
import type { ReadOnlyEditContext } from '../shared/agent-editing/index.js';
import { excerpt } from '../shared/agent-editing/evidence-packets.js';

const toolResultCharacters = 2000;
const thinkingTypes = new Set([
  'thinking',
  'reasoning',
  'thinking_delta',
  'reasoning_delta',
]);

function withoutThinking(value: JsonValue): JsonValue | undefined {
  if (Array.isArray(value)) {
    const clean: JsonValue[] = [];
    for (const item of value) {
      const next = withoutThinking(item);
      if (next !== undefined) clean.push(next);
    }
    return clean;
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.type === 'string' && thinkingTypes.has(value.type))
      return undefined;
    // Tool arguments may legitimately contain fields called reasoning/thinking.
    if (['toolCall', 'tool_call', 'tool_use'].includes(String(value.type)))
      return value;
    const clean: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          'thinking',
          'reasoning',
          'reasoning_content',
          'thinkingSignature',
        ].includes(key)
      )
        continue;
      const next = withoutThinking(item);
      if (next !== undefined) clean[key] = next;
    }
    return clean;
  }
  return value;
}

/** A character prefix, not a model-specific tokenizer or a head/tail excerpt. */
function toolPrefix(value: JsonValue): JsonValue {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const characters = Array.from(text);
  if (characters.length <= toolResultCharacters) return value;
  const flags: JsonObject = {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['exitCode', 'status', 'isError']) {
      const flag = value[key];
      if (
        typeof flag === 'boolean' ||
        typeof flag === 'number' ||
        (typeof flag === 'string' && flag.length <= 100)
      )
        flags[key] = flag;
    }
  }
  return {
    ...flags,
    preview: characters.slice(0, toolResultCharacters).join(''),
    truncated: true,
    originalCharacters: characters.length,
    retainedCharacters: toolResultCharacters,
    unit: 'Unicode characters',
  };
}

function shortenToolResult(event: JsonObject): JsonObject {
  const data =
    event.data !== null &&
    typeof event.data === 'object' &&
    !Array.isArray(event.data)
      ? object(event.data)
      : event;
  if (
    ![
      'tool_result',
      'tool_execution_end',
      'tool-result',
      'toolResult',
    ].includes(String(event.type)) &&
    event.role !== 'tool' &&
    data.role !== 'tool'
  )
    return event;
  const shortened = { ...data };
  for (const key of ['result', 'output', 'content', 'text']) {
    if (Object.hasOwn(shortened, key))
      shortened[key] = toolPrefix(shortened[key]);
  }
  return data === event ? shortened : { ...event, data: shortened };
}

/** All available sanitized events survive; only thinking and tool-return payloads change. */
export function proposerExecutionContext(
  full: JsonObject,
): ReadOnlyEditContext {
  if (
    full.schemaVersion !== 'rsi.evidence-files/v1' ||
    full.view !== 'execution' ||
    !Array.isArray(full.measurements)
  )
    throw new Error('Proposer requires file-backed execution evidence');
  const original = object(full.files);
  const fileText = (file: JsonObject): string => {
    const text = original[string(file.path)];
    if (typeof text !== 'string')
      throw new Error('Missing execution file text');
    return text;
  };
  const files: JsonObject = {};
  const measurements: JsonObject[] = [];
  for (const [mi, raw] of full.measurements.entries()) {
    const measurement = object(raw);
    if (!Array.isArray(measurement.entries))
      throw new Error('Missing execution entries');
    const blocks: string[] = [];
    const attempts: JsonObject[] = [];
    const final: string[] = [];
    const unavailable: JsonObject[] = [];
    for (const rawEntry of measurement.entries) {
      const entry = object(rawEntry);
      if (!Array.isArray(entry.files))
        throw new Error('Missing execution files');
      const entries = entry.files.map((value) => object(value));
      const pathOf = (file: JsonObject): string =>
        typeof object(file.source ?? {}).path === 'string'
          ? string(object(file.source).path)
          : '';
      const available = entries.filter(
        (file) =>
          typeof file.path === 'string' &&
          typeof original[file.path] === 'string',
      );
      for (const file of entries.filter((file) => !available.includes(file)))
        unavailable.push({
          kind: entry.kind ?? null,
          source: file.source ?? null,
          inspection: file.inspection ?? 'unavailable',
        });
      if (entry.kind === 'final-text') {
        for (const file of available) final.push(fileText(file));
        continue;
      }
      if (entry.kind !== 'trajectory') continue;
      const main =
        available.find((file) => pathOf(file) === 'trajectory.jsonl') ??
        available.find((file) => pathOf(file) === 'session.jsonl') ??
        available.find((file) => !pathOf(file));
      if (!main) {
        unavailable.push({
          kind: 'trajectory',
          integrity: entry.integrity ?? 'unknown',
          inspection: 'no-canonical-trace',
          source: entry.artifactRef ?? null,
        });
      } else {
        const events: string[] = [];
        let thinkingRemoved = 0;
        for (const [index, line] of fileText(main).split(/\r?\n/).entries()) {
          if (!line.trim()) continue;
          let value: JsonValue;
          try {
            const parsed: unknown = JSON.parse(line);
            json(parsed);
            value = parsed;
          } catch {
            value = { type: 'unparsed-source-line', text: line };
          }
          const record =
            value !== null && typeof value === 'object' && !Array.isArray(value)
              ? value
              : null;
          const assistantRecord =
            record &&
            (record.role === 'assistant' ||
              (record.role === undefined &&
                ['message', 'assistant_message'].includes(
                  String(record.type),
                )));
          const clean =
            record && thinkingTypes.has(String(record.type))
              ? undefined
              : assistantRecord
                ? withoutThinking(value)
                : value;
          if (clean === undefined) {
            thinkingRemoved++;
            continue;
          }
          const event =
            clean !== null && typeof clean === 'object' && !Array.isArray(clean)
              ? shortenToolResult(clean)
              : clean;
          events.push(`L${index + 1}: ${JSON.stringify(event)}`);
        }
        attempts.push({
          itemId: entry.itemId ?? null,
          attemptId: entry.attemptId ?? null,
          source: main.source ?? null,
          sourceIntegrity: entry.integrity ?? 'unknown',
          sourceTruncated: main.truncated ?? false,
          eventsProvided: events.length,
          thinkingEventsRemoved: thinkingRemoved,
        });
        blocks.push(
          `Trajectory ${pathOf(main) || 'record'} (original source line numbers):\n${events.join('\n')}`,
        );
      }
      for (const file of available.filter((file) =>
        pathOf(file).startsWith('tool-outputs/'),
      )) {
        blocks.push(
          `Tool output ${pathOf(file)}:\n${JSON.stringify(toolPrefix(fileText(file)))}`,
        );
      }
    }
    if (final.length) blocks.push(`Final replies:\n${final.join('\n\n')}`);
    const path = `context/runs/${mi}.txt`;
    if (blocks.length) files[path] = blocks.join('\n\n');
    measurements.push({
      measurementRef: measurement.measurementRef!,
      status: measurement.status ?? 'unknown',
      coverage: measurement.coverage ?? 'unknown',
      attempts,
      supplementaryPath: blocks.length ? path : null,
      finalReply: excerpt(final.join('\n'), 3000),
      unavailable,
    });
  }
  return {
    files,
    evidence: {
      schemaVersion: 'rsi.proposer-execution/v1',
      view: 'execution',
      measurements,
      toolResultLimit: {
        value: toolResultCharacters,
        unit: 'Unicode characters; not exact model tokens',
        keep: 'prefix',
      },
      limitation:
        'The supplied files preserve every available non-thinking event in each canonical sanitized source, without whole-trace truncation. Tool-return previews can be truncated. Missing sources and source-integrity limitations remain unknown; task inputs and delivery binaries are not fabricated.',
    },
    input: {
      readOnlyContext:
        'Read each supplied supplementaryPath event sequence before deciding whether to propose a change. Use read_file with startLine/lineCount to proceed through the recorded phases, calls, results and final text. Inline input is only an inventory and final-reply preview. Only virtual inventory paths are readable; source paths are provenance. context/ files are read-only.',
    },
  };
}
