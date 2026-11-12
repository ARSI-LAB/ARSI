import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { createMetricSelection } from '../shared/metric-selection/index.js';
import type { MetricSelectorConfig } from './schema.js';

export const createMetricSelector: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
>['create'] = async (config, services) =>
  createMetricSelection(config, services, (comparison) => {
    const {
      eligible,
      feasible,
      improved,
      incumbentValue,
      candidateValue,
      minRelativeImprovement,
    } = comparison;
    const accepted = feasible && improved;
    const reason = !eligible
      ? 'Candidate does not satisfy metric prerequisites'
      : !feasible
        ? 'Candidate does not satisfy metric constraints'
        : accepted
          ? 'Candidate metric strictly improves'
          : candidateValue === incumbentValue
            ? 'Metrics are equal; retain the incumbent'
            : minRelativeImprovement > 0
              ? 'Candidate does not exceed the relative improvement threshold; retain the incumbent'
              : 'Candidate does not strictly improve; retain the incumbent';
    return { accepted, reason };
  });
