import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  createMetricSelection,
  type MetricCheck,
} from '../shared/metric-selection/index.js';
import type { MetricSelectorConfig } from './schema.js';

function violation(check: MetricCheck, value: number): number {
  return Math.max(
    0,
    check.min === null ? 0 : check.min - value,
    check.max === null
      ? 0
      : check.exclusiveMax && value === check.max
        ? Number.EPSILON * Math.max(1, Math.abs(check.max))
        : value - check.max,
  );
}

export const createInferenceSelector: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
>['create'] = async (config, services) =>
  createMetricSelection(
    config,
    services,
    (comparison) => {
      if (!comparison.eligible)
        return {
          accepted: false,
          reason: 'Candidate does not satisfy metric eligibility',
        };
      const violations = comparison.constraints.map((check) => ({
        before: violation(check, check.incumbentValue),
        after: violation(check, check.candidateValue),
      }));
      const incumbentFeasible = violations.every(({ before }) => before === 0);
      if (comparison.feasible && !incumbentFeasible)
        return {
          accepted: true,
          reason:
            'Candidate satisfies all metric constraints; incumbent does not',
        };
      if (!comparison.feasible) {
        if (incumbentFeasible)
          return {
            accepted: false,
            reason:
              'Retain the feasible incumbent over an infeasible candidate',
          };
        // Compare each constraint in its own units; never trade one violation for another.
        if (violations.some(({ before, after }) => after > before))
          return {
            accepted: false,
            reason: 'Candidate worsens a metric constraint violation',
          };
        if (violations.some(({ before, after }) => after < before))
          return {
            accepted: violations.some(
              ({ before, after }) =>
                after < before &&
                (before - after) / before >=
                  (config.minProgressImprovement ?? 0),
            ),
            reason:
              'Candidate reduces constraint violations without worsening any; acceptance requires the configured minimum progress',
          };
      }
      return {
        accepted: comparison.improved,
        reason: comparison.improved
          ? 'Candidate metric improves beyond the configured threshold with unchanged feasibility'
          : 'Candidate does not improve the objective beyond the configured threshold; retain the incumbent',
      };
    },
    true,
  );
