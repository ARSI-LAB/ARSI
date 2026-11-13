import { primaryScore, roundAverage } from './measurement-score';
import React from 'react';
import type {
  MeasurementSummary,
  ResultReference,
} from '../../api/observation-client';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { Status } from '../../components/observation-feedback';
import { useRoundLabels } from './round-labels';
import { finalResults } from './final-results';
import { scoreLabel } from './record-identifiers';
import { route } from '../../app/routing';

const variants = ['Base', 'Invariant', 'Domain', 'Composed'] as const;

export function HarnessResults({
  id,
  measurements,
  references,
}: {
  id: string;
  measurements: MeasurementSummary[];
  references: ResultReference[];
}): React.JSX.Element {
  const labels = useRoundLabels();
  const groups = new Map<string, MeasurementSummary[]>();
  for (const measurement of measurements) {
    const stage = labels.harness(measurement.ref);
    if (stage)
      groups.set(stage.round, [
        ...(groups.get(stage.round) ?? []),
        measurement,
      ]);
  }
  const deliveries = finalResults(references, measurements);
  const averages = variants.map((variant) => {
    const rounds = [...groups.values()].map((items) =>
      items.filter((item) => labels.harness(item.ref)?.variant === variant),
    );
    return {
      variant,
      value: roundAverage(rounds),
      count: rounds.filter((items) =>
        items.some((item) => primaryScore(item) !== null),
      ).length,
    };
  });
  return (
    <div className="section-stack policy-results">
      <div className="results-heading">
        <div>
          <h2>Harness comparison</h2>
          <p>Compare each harness stage across recorded task rounds.</p>
        </div>
      </div>
      <div
        className="overview-metrics harness-stage-summary"
        aria-label="Average scores by harness stage"
      >
        {averages.map(({ variant, value, count }) => (
          <div key={variant}>
            <span>{variant}</span>
            <strong>{value === null ? '—' : scoreLabel(value)}</strong>
            <small>
              Average score · {count}/{groups.size} rounds
            </small>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <div className="section-heading">
            <h2>Results by round</h2>
            <span className="muted">{groups.size} rounds</span>
          </div>
        </CardHeader>
        <CardContent className="policy-results-table-content">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Round</TableHead>
                <TableHead>Task</TableHead>
                {variants.map((variant) => (
                  <TableHead key={variant}>{variant}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...groups]
                .sort(([a], [b]) =>
                  a.localeCompare(b, undefined, { numeric: true }),
                )
                .map(([round, records]) => {
                  const tasks = [
                    ...new Set(
                      records
                        .map((item) => labels.task(item.ref))
                        .filter((name): name is string => name !== null),
                    ),
                  ];
                  return (
                    <TableRow key={round}>
                      <TableCell>
                        <strong className="harness-round-label">{round}</strong>
                      </TableCell>
                      <TableCell>
                        <div className="harness-result-task">
                          {tasks.length
                            ? tasks.map((task) => (
                                <span key={task} title={task}>
                                  {task.replace(/^workbuddy\//, '')}
                                </span>
                              ))
                            : '—'}
                        </div>
                      </TableCell>
                      {variants.map((variant) => (
                        <TableCell key={variant}>
                          <div className="harness-score-list">
                            {records
                              .filter(
                                (item) =>
                                  labels.harness(item.ref)?.variant === variant,
                              )
                              .map((item, index, attempts) => {
                                const score = primaryScore(item);
                                return (
                                  <div key={item.ref}>
                                    <a
                                      className="harness-score-link"
                                      href={route(
                                        id,
                                        'measurements',
                                        undefined,
                                        undefined,
                                        { measurement: item.ref },
                                      )}
                                      aria-label={`${round} · ${variant} · ${score === null ? 'Score unavailable' : scoreLabel(score)}`}
                                    >
                                      {score === null ? '—' : scoreLabel(score)}
                                    </a>
                                    {attempts.length > 1 ? (
                                      <small className="muted">
                                        {' '}
                                        · Attempt {index + 1}
                                      </small>
                                    ) : null}
                                    {item.status !== 'succeeded' ? (
                                      <Status value={item.status} />
                                    ) : null}
                                    {item.coverage !== 'complete' ? (
                                      <small className="muted">
                                        {' '}
                                        · {item.coverage}
                                      </small>
                                    ) : null}
                                  </div>
                                );
                              })}
                            {!records.some(
                              (item) =>
                                labels.harness(item.ref)?.variant === variant,
                            )
                              ? '—'
                              : null}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              {groups.size ? (
                <TableRow className="harness-average-row">
                  <TableCell>
                    <strong>Average</strong>
                  </TableCell>
                  <TableCell />
                  {averages.map(({ variant, value, count }) => {
                    return (
                      <TableCell key={variant}>
                        <strong>
                          {value === null ? '—' : scoreLabel(value)}
                        </strong>
                        {count < groups.size ? (
                          <small className="muted">
                            {' '}
                            · {count}/{groups.size} rounds
                          </small>
                        ) : null}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          {!groups.size ? (
            <p className="empty-state">No round evaluations recorded.</p>
          ) : null}
          {deliveries.missingMeasurements.length ? (
            <p className="filter-note">
              Some returned evaluations are unavailable.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
