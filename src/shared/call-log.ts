import type { JsonValue } from '../contracts/index.js';
import type { MetricSelectorOutput } from '../contracts/plugin-types/selector-metrics.js';

export function callLabel(
  binding: string,
  path?: string,
  action?: JsonValue,
): string {
  const step = path?.split('/').at(-1);
  if (binding === '_application') {
    if (action === 'commit') return 'application.commit';
    return step || (typeof action === 'string' ? action : binding);
  }
  return step && step !== binding ? `${binding} (${step})` : binding;
}

export type SelectionLogDetails = Pick<
  MetricSelectorOutput,
  'accepted' | 'metric' | 'incumbentValue' | 'candidateValue' | 'selectedValue'
>;

export function selectionLogDetails(
  output: unknown,
): SelectionLogDetails | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return;
  const { accepted, metric, incumbentValue, candidateValue, selectedValue } =
    output as Partial<Record<keyof SelectionLogDetails, unknown>>;
  if (
    typeof accepted === 'boolean' &&
    typeof metric === 'string' &&
    typeof incumbentValue === 'number' &&
    (candidateValue === null || typeof candidateValue === 'number') &&
    typeof selectedValue === 'number'
  )
    return { accepted, metric, incumbentValue, candidateValue, selectedValue };
}
