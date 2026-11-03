import React from 'react';
import {
  type ExperimentOverview,
  parseCandidates,
  parseMeasurements,
} from '../../api/observation-client';
import { useAllObservations } from './use-observation';
import { Feedback } from '../../components/observation-feedback';
import { recordedDuration } from './experiment-summary';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
export function Overview({
  data,
  children,
}: {
  data: ExperimentOverview;
  children?: React.ReactNode;
}): React.JSX.Element {
  const usage = data.usage;
  const candidates = useAllObservations(
    `/${encodeURIComponent(data.id)}/candidates`,
    parseCandidates,
  );
  const measurements = useAllObservations(
    `/${encodeURIComponent(data.id)}/measurements`,
    parseMeasurements,
  );
  return (
    <div className="section-stack">
      <div className="overview-metrics">
        <div>
          <span>Duration</span>
          <strong>{recordedDuration(data.startedAt, data.finishedAt)}</strong>
        </div>
        <div>
          <span>Candidate versions</span>
          <strong>{candidates.data?.total ?? '—'}</strong>
        </div>
        <div>
          <span>Evaluations</span>
          <strong>{measurements.data?.total ?? '—'}</strong>
        </div>
        <div>
          <span>Model calls</span>
          <strong>
            {usage?.modelCalls?.toLocaleString() ?? 'Not recorded'}
          </strong>
        </div>
      </div>
      <Feedback {...candidates} />
      <Feedback {...measurements} />
      {children}
      <Card>
        <CardHeader>
          <h2>Resource usage</h2>
        </CardHeader>
        <CardContent>
          {usage && Object.keys(usage).length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Recorded usage</TableHead>
                  <TableHead>Configured limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(usage).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell>{key}</TableCell>
                    <TableCell>
                      <strong>{value.toLocaleString()}</strong>
                    </TableCell>
                    <TableCell>
                      {data.limits[key]?.toLocaleString() ?? 'Not specified'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="empty-state">No usage has been recorded.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
