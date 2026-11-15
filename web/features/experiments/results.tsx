import { HarnessResults } from './harness-results';
import { useRoundLabels, useCallRecords } from './round-labels';
import React from 'react';
import {
  parseDetails,
  parseMeasurements,
  parseCandidates,
} from '../../api/observation-client';
import { Feedback, Status } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { finalResults } from './final-results';
import { FinalMeasurementMetrics } from './final-measurement-metrics';
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
                        <FinalMeasurementMetrics
                          measurement={measurement}
                          measurements={measurements.data?.items ?? []}
                          candidates={candidates.data?.items ?? []}
                        />
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
