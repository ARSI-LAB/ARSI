import React from 'react';
import type { MeasurementSummary } from '../../api/observation-client';
import { primaryMetric, metricLabel } from './measurement-score';
import { scoreLabel } from './record-identifiers';

export function MeasurementMetrics({
  metrics,
}: {
  metrics: MeasurementSummary['metrics'];
}): React.JSX.Element {
  const primary = primaryMetric(metrics);
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
      {[
        primary,
        ...metrics.filter(
          (metric) =>
            metric !== primary && metric !== passed && metric !== total,
        ),
      ].map((metric) => (
        <div
          key={JSON.stringify([metric.name, metric.definitionRef, metric.unit])}
        >
          <dt>{metricLabel(metric)}</dt>
          <dd>{value(metric)}</dd>
        </div>
      ))}
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
