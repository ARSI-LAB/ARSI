import React from 'react';
import type {
  ExperimentOverview,
  MeasurementSummary,
} from '../../api/observation-client';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { Status } from '../../components/observation-feedback';
import { route } from '../../app/routing';
import { metricLabel, metricValue, primaryMetric } from './measurement-score';
import { scoreLabel } from './record-identifiers';

function recordedScore(measurement: MeasurementSummary): number | null {
  const metric = primaryMetric(measurement.metrics);
  return measurement.coverage === 'complete' && metric
    ? metricValue(measurement, metric)
    : null;
}

/** Recorded evaluations remain visible independently of Policy-specific final output. */
export function ResultProgress({
  experiment,
  measurements,
  hasFinalOutput,
}: {
  experiment: ExperimentOverview;
  measurements: MeasurementSummary[];
  hasFinalOutput: boolean;
}): React.JSX.Element {
  const active = ['running', 'starting'].includes(experiment.status);
  const title = active
    ? 'Experiment in progress'
    : experiment.status === 'failed'
      ? 'Experiment failed'
      : experiment.status === 'cancelled'
        ? 'Experiment cancelled'
        : hasFinalOutput
          ? 'Final results saved'
          : 'No final output saved';
  const recent = [...measurements]
    .sort((a, b) =>
      (b.finishedAt ?? b.startedAt ?? '').localeCompare(
        a.finishedAt ?? a.startedAt ?? '',
      ),
    )
    .slice(0, 3);
  return (
    <Card>
      <CardHeader>
        <div className="section-heading">
          <h2>{title}</h2>
          <Status value={experiment.status} />
        </div>
        <p className="muted">
          {active
            ? 'Recorded evaluations are intermediate observations. Final results appear when the Policy returns.'
            : hasFinalOutput
              ? 'Final output and recorded evaluations are retained below.'
              : 'The experiment has no saved final output. Recorded evaluations are retained for inspection.'}
        </p>
      </CardHeader>
      <CardContent className="section-stack">
        <div
          className="overview-metrics"
          aria-label="Recorded evaluation progress"
        >
          <div>
            <span>Recorded evaluations</span>
            <strong>{measurements.length}</strong>
          </div>
          <div>
            <span>Complete scores</span>
            <strong>
              {
                measurements.filter((item) => recordedScore(item) !== null)
                  .length
              }
            </strong>
          </div>
          <div>
            <span>Failed or cancelled</span>
            <strong>
              {
                measurements.filter((item) =>
                  ['failed', 'cancelled'].includes(item.status),
                ).length
              }
            </strong>
          </div>
          <div>
            <span>Incomplete coverage</span>
            <strong>
              {
                measurements.filter((item) => item.coverage !== 'complete')
                  .length
              }
            </strong>
          </div>
        </div>
        {recent.length ? (
          <ul>
            {recent.map((measurement) => {
              const value = recordedScore(measurement);
              const metric = primaryMetric(measurement.metrics);
              return (
                <li key={measurement.ref}>
                  <a
                    className="text-link"
                    href={route(
                      experiment.id,
                      'measurements',
                      undefined,
                      undefined,
                      { measurement: measurement.ref },
                    )}
                  >
                    {metric ? metricLabel(metric) : 'Evaluation'}:{' '}
                    {value === null ? 'Unavailable' : scoreLabel(value)}
                  </a>{' '}
                  <Status value={measurement.status} />
                  {measurement.coverage !== 'complete' ? (
                    <span className="muted">
                      {' '}
                      · Coverage: {measurement.coverage}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">
            {active
              ? 'Waiting for the first recorded evaluation.'
              : 'No evaluations were recorded before this experiment stopped.'}
          </p>
        )}
        <div className="actions">
          <a className="text-link" href={route(experiment.id, 'measurements')}>
            View all evaluations
          </a>
          <a className="text-link" href={route(experiment.id, 'calls')}>
            View call history
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
