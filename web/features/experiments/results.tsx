import { HarnessResults } from './harness-results';
import { useRoundLabels, useCallRecords } from './round-labels';
import React from 'react';
import {
  parseDetails,
  parseMeasurements,
  parseCandidates,
} from '../../api/observation-client';
import { scoreLabel } from './record-identifiers';
import { Feedback, Status } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { finalResults } from './final-results';
import { comparableBaseline } from './experiment-summary';
import { useAllObservations, useObservation } from './use-observation';
import { InferenceReport } from './inference-report';
import { inferenceSummary } from './inference-summary';

export function Results({ id }: { id: string }): React.JSX.Element {
  const labels = useRoundLabels();
  const records = useCallRecords();
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
    `/${encodeURIComponent(id)}/measurements`,
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
  const activeMetric = (metrics.find(
    ([, metric]) => metric.name === 'meanReward',
  ) ??
    metrics.find(([, metric]) => metric.name === 'score') ??
    metrics.find(([, metric]) => 'value' in metric.values) ??
    metrics[0])?.[0];
  if (!records.calls.data) return <Feedback {...records.calls} />;
  if (
    inferenceSummary(
      measurements.data?.items ?? [],
      candidates.data?.items ?? [],
    )
  )
    return (
      <div className="section-stack">
        <Feedback {...details} />
        <Feedback {...measurements} />
        <Feedback {...candidates} />
        <InferenceReport
          id={id}
          measurements={measurements.data!.items}
          candidates={candidates.data?.items ?? []}
          resultReferences={references}
        />
      </div>
    );
  if (labels.isHarness)
    return (
      <div className="section-stack">
        <Feedback {...details} />
        <Feedback {...measurements} />
        {measurements.data && details.data ? (
          <HarnessResults
            id={id}
            measurements={measurements.data.items}
            references={references}
          />
        ) : null}
      </div>
    );
  return (
    <div className="section-stack policy-results">
      <div className="results-heading">
        <div>
          <h2>Saved results</h2>
          <p>Review returned candidates and recorded evaluation metrics.</p>
        </div>
      </div>
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
                <h2>{labels.isHarness ? 'Task deliveries' : 'Final result'}</h2>
              </CardHeader>
              <CardContent className="section-stack">
                <div className="overview-metrics">
                  <div>
                    <span>Generated candidates</span>
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
                        ? labels.isHarness
                          ? 'Delivered candidates'
                          : 'Final candidates'
                        : labels.isHarness
                          ? 'Delivered candidate'
                          : 'Final candidate'}
                    </span>
                    {measurements.loading ? (
                      <span>Loading…</span>
                    ) : (
                      final.candidates.map((candidate) => (
                        <span key={candidate}>
                          {labels.candidate(candidate)}
                        </span>
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
              <CardContent className="section-stack">
                <div className="result-stats">
                  {final.scores.map(({ measurement }) => {
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
                      <div
                        key={measurement.ref}
                        className="final-score-summary"
                      >
                        <div className="section-heading">
                          <h3>
                            {labels
                              .evaluation(measurement.ref)
                              .replace(' · Validation', ' · Validation set')
                              .replace(' · Training', ' · Optimization set')}
                          </h3>
                          {measurement.status !== 'succeeded' ? (
                            <Status value={measurement.status} />
                          ) : null}
                        </div>
                        {labels.task(measurement.ref) ? (
                          <p className="muted harness-task-label">
                            {labels.task(measurement.ref)}
                          </p>
                        ) : null}
                        <div className="final-score-metrics">
                          <div className="final-score-main">
                            <span>
                              {metric?.name === 'meanReward'
                                ? 'Average score'
                                : (metric?.name ?? 'Final score')}
                            </span>
                            <strong>
                              {finalValue == null
                                ? '—'
                                : scoreLabel(finalValue)}
                            </strong>
                          </div>
                          <div>
                            <span>Baseline</span>
                            <strong>
                              {baselineValue == null
                                ? '—'
                                : scoreLabel(baselineValue)}
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
                        {metric && metric.status !== 'available' ? (
                          <p className="muted">
                            {metric.reason ?? metric.status}
                          </p>
                        ) : null}
                        {metric?.status === 'available' &&
                        finalValue == null ? (
                          <p className="muted">
                            {Object.entries(metric.values)
                              .map(
                                ([name, value]) =>
                                  `${name}: ${value == null ? 'Not recorded' : scoreLabel(value)}`,
                              )
                              .join(' · ') || 'Not recorded'}
                          </p>
                        ) : null}
                        {delta == null &&
                        candidates.data &&
                        metric?.status === 'available' ? (
                          <p className="muted">
                            No comparable baseline recorded.
                          </p>
                        ) : null}
                        {measurement.coverage !== 'complete' ? (
                          <p className="filter-note">
                            Coverage: {measurement.coverage}
                          </p>
                        ) : null}
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
