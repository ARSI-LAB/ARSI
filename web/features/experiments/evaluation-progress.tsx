import React from 'react';
import type { MeasurementSummary } from '../../api/observation-client';
import { route } from '../../app/routing';
import { Status } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { MeasurementMetrics } from './measurement-metrics';

/** Persisted evaluations remain inspectable before a Policy returns its output. */
export function EvaluationProgress({
  id,
  measurements,
  evaluationLabel,
}: {
  id: string;
  measurements: readonly MeasurementSummary[];
  evaluationLabel: (ref: string) => string;
}): React.JSX.Element {
  const complete = measurements.filter(
    (item) => item.status === 'succeeded' && item.coverage === 'complete',
  ).length;
  const recent = [...measurements]
    .sort((a, b) =>
      (b.finishedAt ?? b.startedAt ?? '').localeCompare(
        a.finishedAt ?? a.startedAt ?? '',
      ),
    )
    .slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <div className="section-heading">
          <h2>Evaluation progress</h2>
          <a className="text-link" href={route(id, 'measurements')}>
            View all evaluations
          </a>
        </div>
      </CardHeader>
      <CardContent className="section-stack">
        <div className="overview-metrics">
          <div>
            <span>Recorded evaluations</span>
            <strong>{measurements.length}</strong>
          </div>
          <div>
            <span>Succeeded with complete coverage</span>
            <strong>{complete}</strong>
          </div>
          <div>
            <span>Other status or coverage</span>
            <strong>{measurements.length - complete}</strong>
          </div>
        </div>
        <p className="muted">
          Recorded evaluations are intermediate evidence. Final results appear
          when the Policy saves its output; different evaluation sets are shown
          separately.
        </p>
        {recent.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recent evaluation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Recorded metrics</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((measurement) => (
                <TableRow key={measurement.ref}>
                  <TableCell>
                    <a
                      className="text-link"
                      href={route(id, 'measurements', undefined, undefined, {
                        measurement: measurement.ref,
                      })}
                    >
                      {evaluationLabel(measurement.ref)}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Status value={measurement.status} />
                  </TableCell>
                  <TableCell>{measurement.coverage}</TableCell>
                  <TableCell>
                    <MeasurementMetrics metrics={measurement.metrics} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="empty-state">
            No evaluations have been saved yet. Check Call history for work in
            progress; each evaluation appears here after it is saved.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
