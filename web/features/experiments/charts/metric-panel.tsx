import React from 'react';
import { route } from '../../../app/routing';
import { useRoute } from '../../../app/use-route';
import {
  parseMetricRecords,
  parseMeasurements,
  parseCandidates,
  parseDetails,
} from '../../../api/observation-client';
import { Card, CardContent, CardHeader } from '../../../components/ui/card';
import { useAllObservations } from '../use-observation';
import { QueryNotice } from './chart-controls';
import { ScorePlot } from './metric-chart';
import { finalResults } from '../final-results';
import { candidateLabel } from '../record-identifiers';
import { useObservation } from '../use-observation';
export function ScoreCharts({
  id,
  comparison = false,
  candidate,
}: {
  id: string;
  comparison?: boolean;
  candidate?: string;
}): React.JSX.Element {
  const selection = useRoute();
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/metric-observations`,
    parseMetricRecords,
  );
  const evaluations = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
  );
  const candidates = useAllObservations(
    `/${encodeURIComponent(id)}/candidates`,
    parseCandidates,
  );
  const details = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
    15000,
  );
  const final = finalResults(
    details.data?.resultReferences ?? [],
    evaluations.data?.items ?? [],
  );
  const known = new Set(evaluations.data?.items.map((item) => item.ref));
  const inconsistent =
    !!result.data &&
    !!evaluations.data &&
    result.data.items.some((item) => !known.has(item.ref));
  return (
    <Card>
      <CardHeader>
        <div className="section-heading">
          <div>
            <h2>{comparison ? 'Candidate comparison' : 'Metric history'}</h2>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <QueryNotice
          loading={result.loading || evaluations.loading}
          error={
            result.error ||
            evaluations.error ||
            (inconsistent
              ? 'Evaluation records changed while loading. Reload the chart to align the sequence.'
              : '')
          }
          refresh={() => {
            result.refresh();
            evaluations.refresh();
          }}
        />
        {result.data && evaluations.data && !inconsistent ? (
          <>
            {candidate ? (
              <p className="filter-note">
                Showing candidate{' '}
                <code title={candidate}>{candidateLabel(candidate)}</code>{' '}
                <a
                  className="text-link"
                  href={route(
                    id,
                    comparison ? 'measurements' : 'overview',
                    undefined,
                    undefined,
                    selection,
                  )}
                >
                  Clear candidate filter
                </a>
              </p>
            ) : null}
            <ScorePlot
              id={id}
              measurements={result.data.items}
              evaluations={evaluations.data.items}
              roots={
                candidates.data?.items
                  .filter((item) => item.parentRef === null)
                  .map((item) => item.ref) ?? []
              }
              finals={final.candidates}
              candidate={candidate}
              comparison={comparison}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
