import { AgentOutputError } from '../../../contracts/runtime/errors.js';
import type { JsonObject } from '../../../contracts/index.js';
import { canonical, object } from '../../../shared/json.js';

export function outputInstructions(schema: JsonObject): string {
  return (
    'Return only a JSON object conforming to this JSON Schema as your final response, without a result envelope or prose.\n\n' +
    canonical(schema)
  );
}

/** Decode the final model answer once; native protocol parsing stays in adapters. */
export function parseAgentResult(text: string): JsonObject {
  const trimmed = text.trim();
  const extracted = extractJsonObject(trimmed);
  try {
    return object(JSON.parse(extracted?.value ?? trimmed));
  } catch (error) {
    throw new AgentOutputError('Agent final response must be a JSON object', {
      cause: error,
    });
  }
}

/**
 * Select the model's final answer from prose and intermediate JSON examples.
 * Fenced output outranks inline examples because it is the explicit final
 * answer. Unfenced proposal batches remain a fallback for native agents that
 * omit Markdown. Scanning is string-aware so prose braces stay inert.
 */
function extractJsonObject(
  text: string,
): { value: string; fenced: boolean } | null {
  const fences: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(
    /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi,
  )) {
    const body = match[1];
    const offset = (match.index ?? 0) + match[0].indexOf(body);
    fences.push({ start: offset, end: offset + body.length });
  }
  const complete: Array<{
    value: string;
    parsed: JsonObject;
    fenced: boolean;
  }> = [];
  let incomplete: { value: string; fenced: boolean } | null = null;
  for (
    let start = text.indexOf('{');
    start !== -1;
    start = text.indexOf('{', start + 1)
  ) {
    const scanned = scanObjectAt(text, start);
    const fenced = fences.some(
      (range) => start >= range.start && start < range.end,
    );
    if (scanned) {
      incomplete ??= { value: scanned.value, fenced };
    }
    if (scanned?.complete) {
      start += scanned.value.length - 1;
      try {
        complete.push({
          value: scanned.value,
          parsed: object(JSON.parse(scanned.value)),
          fenced,
        });
      } catch {
        // A balanced non-JSON object is not evidence; its nested braces are
        // part of the same malformed candidate and must not be considered.
      }
    }
  }
  for (let index = complete.length - 1; index >= 0; index -= 1) {
    const candidate = complete[index]!;
    if (candidate.fenced) return candidate;
  }
  for (let index = complete.length - 1; index >= 0; index -= 1) {
    const candidate = complete[index]!;
    if (Array.isArray(candidate.parsed.proposals)) return candidate;
  }
  return complete.at(-1) ?? incomplete;
}

function scanObjectAt(
  text: string,
  start: number,
): { value: string; complete: boolean } | null {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted) {
      if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}') {
      if (stack.pop() !== '{') return null;
    } else if (character === ']') {
      if (stack.pop() !== '[') return null;
    } else if (stack.length === 0) {
      return null;
    }
    if (stack.length === 0 && !quoted && character === '}') {
      return { value: text.slice(start, index + 1), complete: true };
    }
  }
  if (stack.length === 0 && !quoted) return null;
  return { value: text.slice(start), complete: false };
}
