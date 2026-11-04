import React from 'react';
import type { MeasurementSummary } from '../../api/observation-client';
import { scoreLabel } from './record-identifiers';

export function MeasurementMetrics({
  metrics,
}: {
  metrics: MeasurementSummary['metrics'];
}): React.JSX.Element {
  const primary =
    [
      'meanReward',
      'score',
      'reward.reward',
      'reward.overall',
      'reward.test_pass_rate',
    ]
      .map((name) => metrics.find((metric) => metric.name === name))
      .find(Boolean) ?? metrics[0];
  const passed = metrics.find(
    (metric) => metric.name === 'reward.tests_passed',
  );
  const total = metrics.find((metric) => metric.name === 'reward.tests_total');
  const value = (metric: typeof primary | undefined): string => {
    if (!metric) return '—';
    if (metric.status !== 'available') return metric.reason ?? metric.status;
    if ('value' in metric.values)
      return metric.values.value == null
        ? '—'
        : scoreLabel(metric.values.value);
    return (
      Object.entries(metric.values)
        .map(
          ([name, number]) =>
            `${name}: ${number == null ? '—' : scoreLabel(number)}`,
        )
        .join(' · ') || '—'
    );
  };
  if (!primary) return <p className="muted">No metrics recorded.</p>;
  return (
    <dl className="measurement-metrics">
      <div>
        <dt>
          {primary.name === 'meanReward'
            ? 'Average score'
            : ['score', 'reward.reward', 'reward.overall'].includes(
                  primary.name,
                )
              ? 'Score'
              : primary.name === 'reward.test_pass_rate'
                ? 'Pass rate'
                : primary.name}
        </dt>
        <dd>{value(primary)}</dd>
      </div>
      {passed || total ? (
        <div>
          <dt>Tests passed</dt>
          <dd>
            {value(passed)}
            {total ? ` / ${value(total)}` : ''}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
