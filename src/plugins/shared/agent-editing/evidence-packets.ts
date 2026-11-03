import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';

/** Bound UTF-8 text without splitting a character; every omission is explicit. */
export function excerpt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const take = (value: string, budget: number): string => {
    let result = '';
    let bytes = 0;
    for (const char of value) {
      bytes += Buffer.byteLength(char);
      if (bytes > budget) break;
      result += char;
    }
    return result;
  };
  const half = Math.max(0, Math.floor((maxBytes - 100) / 2));
  return (
    take(text, half) +
    '\n[... middle omitted; consult supplied supplementary evidence when available ...]\n' +
    Array.from(take(Array.from(text).reverse().join(''), half))
      .reverse()
      .join('')
  );
}

function trajectory(text: string): string {
  const events: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      events.push(`L${index + 1}: ${excerpt(line, 1200)}`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      continue;
    const event = object(value);
    if (['thinking', 'usage', 'status'].includes(String(event.type))) continue;
    events.push(`L${index + 1}: ${excerpt(JSON.stringify(event), 1600)}`);
  }
  return events.join('\n');
}

/** Project already-authorized, sanitized execution files into one packet per run. */
export function executionEvidencePackets(full: JsonObject): {
  files: JsonObject;
  evidence: JsonObject;
} {
  const original = object(full.files);
  if (!Array.isArray(full.measurements))
    throw new Error('Missing execution measurements');
  const files: JsonObject = {};
  const measurements: JsonObject[] = [];
  const quota = Math.max(
    500,
    Math.floor(24000 / Math.max(1, full.measurements.length)),
  );
  for (const [index, raw] of full.measurements.entries()) {
    const measurement = object(raw);
    if (!Array.isArray(measurement.entries))
      throw new Error('Missing execution entries');
    const traceFiles: JsonObject[] = [];
    const final: string[] = [];
    const unavailable: JsonValue[] = [];
    for (const rawEntry of measurement.entries) {
      const entry = object(rawEntry);
      if (!Array.isArray(entry.files)) continue;
      for (const rawFile of entry.files) {
        const file = object(rawFile);
        if (
          typeof file.path !== 'string' ||
          typeof original[file.path] !== 'string'
        ) {
          unavailable.push({
            kind: entry.kind ?? null,
            source: file.source ?? null,
            inspection: file.inspection ?? 'unavailable',
          });
          continue;
        }
        if (entry.kind === 'final-text')
          final.push(string(original[file.path]));
        if (entry.kind === 'trajectory') traceFiles.push(file);
      }
    }
    const sourcePath = (file: JsonObject): string =>
      typeof object(file.source ?? {}).path === 'string'
        ? string(object(file.source).path)
        : '';
    const main =
      traceFiles.find((f) => sourcePath(f) === 'trajectory.jsonl') ??
      traceFiles.find((f) => sourcePath(f) === 'session.jsonl') ??
      traceFiles.find((f) => /\.jsonl$/i.test(sourcePath(f)));
    const sections: string[] = [];
    if (main) {
      const normalized = trajectory(string(original[string(main.path)]));
      const errors = normalized
        .split('\n')
        .filter((line) =>
          /"isError":true|"type":"error"|"exitCode":[1-9]/.test(line),
        );
      if (errors.length)
        sections.push(
          `Observed error events:\n${excerpt(errors.join('\n'), 3000)}`,
        );
      sections.push(
        `Trajectory (${sourcePath(main)}; original line numbers):\n${normalized}`,
      );
    }
    const seen = new Set(main ? [string(original[string(main.path)])] : []);
    // Large payloads remain bounded; do not expose installation/configuration files.
    for (const file of traceFiles.filter((f) =>
      sourcePath(f).startsWith('tool-outputs/'),
    )) {
      const text = string(original[string(file.path)]);
      if (!text.trim() || seen.has(text)) continue;
      seen.add(text);
      sections.push(
        `Tool output (${sourcePath(file)}):\n${excerpt(text, 1800)}`,
      );
    }
    const packet = sections.join('\n\n');
    const path = `context/runs/${index}.txt`;
    if (packet) files[path] = excerpt(packet, 24000);
    measurements.push({
      measurementRef: measurement.measurementRef!,
      status: measurement.status ?? 'unknown',
      coverage: measurement.coverage ?? 'unknown',
      finalReply: excerpt(final.join('\n'), Math.floor(quota / 3)),
      excerpts: excerpt(packet, Math.floor((quota * 2) / 3)),
      supplementaryPath: packet ? path : null,
      source: main?.source ?? null,
      inputFiles: traceFiles.length,
      omittedFiles: traceFiles.filter(
        (f) => f !== main && !sourcePath(f).startsWith('tool-outputs/'),
      ).length,
      supplementalTruncated: Buffer.byteLength(packet) > 24000,
      excerptsTruncated:
        Buffer.byteLength(packet) > Math.floor((quota * 2) / 3),
      unavailable,
    });
  }
  return {
    files,
    evidence: {
      schemaVersion: 'rsi.memory-evidence/v1',
      view: 'execution',
      measurements,
      limitation:
        'Deterministic excerpts are incomplete observations, not correctness or edit-effect verdicts. Missing actions cannot be inferred from omissions. Full sources remain in immutable artifacts.',
    },
  };
}
