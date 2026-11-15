import React from 'react';
import type {
  CandidateSummary,
  MeasurementSummary,
} from '../../api/observation-client';
import { comparableBaseline } from './experiment-summary';
import { scoreLabel } from './record-identifiers';

/** Each returned evaluation owns its metrics; different outputs can use different definitions. */
export function FinalMeasurementMetrics({
  measurement,
  measurements,
  candidates,
}: {
  measurement: MeasurementSummary;
  measurements: readonly MeasurementSummary[];
  candidates: readonly CandidateSummary[];
}): React.JSX.Element {
  if (!measurement.metrics.length)
    return <p className="empty-state">No metrics recorded.</p>;
  return (
    <div className="section-stack">
      {measurement.metrics.map((metric, index) => {
        const baseline = comparableBaseline(
          measurement,
          metric,
          measurements,
          candidates,
        );
        const baselineValue = baseline?.values.value;
        const finalValue =
          measurement.status === 'succeeded' && metric.status === 'available'
            ? metric.values.value
            : null;
        const delta =
          typeof finalValue === 'number' && typeof baselineValue === 'number'
            ? finalValue - baselineValue
            : null;
        return (
          <div key={index}>
            <div className="final-score-metrics">
              <div className="final-score-main">
                <span>
                  {metric.name}
                  {metric.unit ? ` (${metric.unit})` : ''}
                </span>
                <strong>
                  {finalValue == null ? '—' : scoreLabel(finalValue)}
                </strong>
              </div>
              <div>
                <span>Baseline</span>
                <strong>
                  {baselineValue == null ? '—' : scoreLabel(baselineValue)}
                </strong>
              </div>
              <div>
                <span>Change</span>
                <strong>
                  {delta == null
                    ? '—'
                    : `${delta > 0 ? '+' : ''}${scoreLabel(delta)}`}
                </strong>
              </div>
            </div>
            {metric.status !== 'available' ? (
              <p className="muted">{metric.reason ?? metric.status}</p>
            ) : measurement.status === 'succeeded' && finalValue == null ? (
              <p className="muted">
                {Object.entries(metric.values)
                  .map(
                    ([name, value]) =>
                      `${name}: ${value == null ? 'Not recorded' : scoreLabel(value)}`,
                  )
                  .join(' · ') || 'Not recorded'}
              </p>
            ) : null}
            {delta == null && metric.status === 'available' ? (
              <p className="muted">No comparable baseline recorded.</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
