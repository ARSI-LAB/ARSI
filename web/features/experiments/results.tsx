import React from 'react';
import { candidateLabel, evaluationOrdinals } from './record-identifiers';
import {
  parseDetails,
  parseMeasurements,
  parseCandidates,
} from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { Feedback, Status } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { finalResults } from './final-results';
import { comparableBaseline } from './experiment-summary';
import { useAllObservations, useObservation } from './use-observation';

export function Results({ id }: { id: string }): React.JSX.Element {
  const selectedMetric = useRoute().metric;
  const candidates = useAllObservations(
    `/${encodeURIComponent(id)}/candidates`,
    parseCandidates,
  );
  const details = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
  );
  const references = details.data?.resultReferences ?? [];
  const measurements = useAllObservations(
    references.some((reference) => reference.kind === 'measurement')
      ? `/${encodeURIComponent(id)}/measurements`
      : null,
    parseMeasurements,
  );
  const final = finalResults(references, measurements.data?.items ?? []);
  const metricKey = (metric: { name: string; unit: string }): string =>
    JSON.stringify([metric.name, metric.unit]);
  const metrics = [
    ...new Map(
      final.scores.flatMap(({ measurement }) =>
        measurement.metrics.map(
          (metric) => [metricKey(metric), metric] as const,
        ),
      ),
    ).entries(),
  ];
  const activeMetric = metrics.some(([key]) => key === selectedMetric)
    ? selectedMetric
    : (metrics.find(([, metric]) => 'value' in metric.values)?.[0] ??
      metrics[0]?.[0]);
  return (
    <div className="section-stack">
      <Feedback {...details} />
      {details.data ? (
        !details.data.result ? (
          <p className="empty-state">
            No final result was recorded for this experiment.
          </p>
        ) : (
          <>
            <Card>
              <CardHeader>
                <h2>Final result</h2>
              </CardHeader>
              <CardContent className="section-stack">
                <div className="overview-metrics">
                  <div>
                    <span>New versions</span>
                    <strong>
                      {candidates.data
                        ? candidates.data.items.filter(
                            (candidate) => candidate.parentRef !== null,
                          ).length
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>
                      {final.candidates.length > 1
                        ? 'Final candidates'
                        : 'Final candidate'}
                    </span>
                    {measurements.loading ? (
                      <span>Loading…</span>
                    ) : (
                      final.candidates.map((candidate) => (
                        <a
                          className="text-link"
                          key={candidate}
                          href={route(id, 'candidates', candidate)}
                        >
                          {candidateLabel(candidate)} · {candidate}
                        </a>
                      ))
                    )}
                  </div>
                </div>
                <Feedback {...candidates} />
                <Feedback {...measurements} />
                {!final.candidates.length && !measurements.loading ? (
                  <p className="empty-state">
                    No final candidate reference is available in the saved
                    output.
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <h2>Experiment scores</h2>
              </CardHeader>
              <CardContent className="section-stack">
                {metrics.length ? (
                  <label className="browser-search">
                    Metric
                    <select
                      value={activeMetric}
                      onChange={(event) =>
                        replaceRouteSelection({ metric: event.target.value })
                      }
                    >
                      {metrics.map(([key, metric]) => (
                        <option key={key} value={key}>
                          {metric.name} ({metric.unit})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="result-stats">
                  {final.scores.map(({ measurement, paths }, index) => {
                    const metric = measurement.metrics.find(
                      (item) => metricKey(item) === activeMetric,
                    );
                    const baseline = metric
                      ? comparableBaseline(
                          measurement,
                          metric,
                          measurements.data?.items ?? [],
                          candidates.data?.items ?? [],
                        )
                      : null;
                    const baselineValue = baseline?.values.value;
                    const finalValue =
                      metric?.status === 'available'
                        ? metric.values.value
                        : null;
                    const delta =
                      typeof finalValue === 'number' &&
                      typeof baselineValue === 'number'
                        ? finalValue - baselineValue
                        : null;
                    return (
                      <div key={measurement.ref}>
                        <div className="section-heading">
                          <h3 title={paths.join(' · ')}>
                            {paths.includes('/testMeasurementRef')
                              ? 'Final test score'
                              : paths.includes('/measurementRef')
                                ? 'Final optimization score'
                                : final.scores.length === 1
                                  ? 'Final score'
                                  : `Final score ${index + 1}`}
                          </h3>
                          <Status value={measurement.status} />
                        </div>

                        {metric ? (
                          metric.status === 'available' ? (
                            Object.keys(metric.values).length ? (
                              Object.entries(metric.values).map(
                                ([name, value]) => (
                                  <p key={name}>
                                    {name === 'value' ? '' : `${name}: `}
                                    <strong className="stat-number">
                                      {value === null
                                        ? 'Not recorded'
                                        : value.toLocaleString(undefined, {
                                            maximumSignificantDigits: 21,
                                          })}
                                    </strong>{' '}
                                    {metric.unit}
                                  </p>
                                ),
                              )
                            ) : (
                              <p>Not recorded</p>
                            )
                          ) : (
                            <p>
                              {metric.status}:{' '}
                              {metric.reason ?? 'No value recorded'}
                            </p>
                          )
                        ) : (
                          <p>No value for this metric.</p>
                        )}
                        {delta !== null ? (
                          <p className="result-change">
                            Baseline{' '}
                            {baselineValue?.toLocaleString(undefined, {
                              maximumSignificantDigits: 21,
                            })}{' '}
                            → Final{' '}
                            {finalValue?.toLocaleString(undefined, {
                              maximumSignificantDigits: 21,
                            })}
                            <br />
                            Change {delta > 0 ? '+' : ''}
                            {Number(delta.toPrecision(12)).toLocaleString(
                              undefined,
                              { maximumSignificantDigits: 12 },
                            )}{' '}
                            {metric?.unit}
                          </p>
                        ) : candidates.data &&
                          metric?.status === 'available' ? (
                          <p className="muted">
                            No unique comparable baseline recorded.
                          </p>
                        ) : null}
                        {measurement.coverage !== 'complete' ? (
                          <p className="filter-note">
                            Coverage: {measurement.coverage}
                          </p>
                        ) : null}
                        <a
                          className="text-link"
                          href={route(
                            id,
                            'measurements',
                            undefined,
                            undefined,
                            { measurement: measurement.ref },
                          )}
                        >
                          View evaluation #
                          {evaluationOrdinals(
                            measurements.data?.items ?? [],
                          ).get(measurement.ref)}{' '}
                          →
                        </a>
                      </div>
                    );
                  })}
                </div>
                {measurements.data && final.missingMeasurements.length ? (
                  <p className="error-notice" role="status">
                    A returned measurement is no longer available in the
                    experiment records.
                  </p>
                ) : null}
                {!references.some(
                  (reference) => reference.kind === 'measurement',
                ) ? (
                  <p className="empty-state">
                    No final measurement reference was recorded. Other
                    measurements are available in Measurements.
                  </p>
                ) : null}
                {details.data.result.truncated ? (
                  <p className="filter-note">
                    The saved output exceeds the preview limit. Final references
                    cannot be determined from this preview.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </>
        )
      ) : null}
    </div>
  );
}
