import { MeasurementMetrics } from './measurement-metrics';
import { metricValue, primaryMetric, metricLabel } from './measurement-score';
import { scoreLabel } from './record-identifiers';
import { useRoundLabels } from './round-labels';
import React, { useState } from 'react';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import {
  parseMeasurements,
  parseMetricRecords,
} from '../../api/observation-client';
import { route } from '../../app/routing';
import {
  Feedback,
  Pagination,
  Status,
  Timestamp,
} from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useAllObservations } from './use-observation';
export function Measurements({
  id,
  candidate,
  measurement: selected,
}: {
  id: string;
  candidate?: string;
  measurement?: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const [round, setRound] = useState('');
  const [stage, setStage] = useState('');
  const roundName = (ref: string): string =>
    labels
      .evaluation(ref)
      .replace('Baseline evaluation', 'Baseline')
      .split(' · ')[0]!;
  const stageName = (ref: string): string => {
    const phase = labels.harness(ref);
    if (phase) return phase.variant;
    const label = labels.evaluation(ref);
    return /Training/.test(label)
      ? 'Optimization set'
      : /Validation|Baseline evaluation/.test(label)
        ? 'Validation set'
        : /Final test/.test(label)
          ? 'Final test'
          : 'Other';
  };
  const requestedOffset = useRoute().offset ?? 0;
  const setOffset = (offset: number): void => replaceRouteSelection({ offset });
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
  );
  const taskRecords = useAllObservations(
    selected ? `/${encodeURIComponent(id)}/metric-observations` : null,
    parseMetricRecords,
  );
  const metric = primaryMetric(
    result.data?.items.flatMap((item) => item.metrics) ?? [],
  );
  const inference = metric?.name === 'outputThroughput';
  const rounds = [
    ...new Set(result.data?.items.map((item) => roundName(item.ref))),
  ];
  const stages = [
    ...new Set(result.data?.items.map((item) => stageName(item.ref))),
  ];
  const matching =
    result.data?.items.filter(
      (item) =>
        (!selected || item.ref === selected) &&
        (!candidate || item.candidateRef === candidate) &&
        (selected || !round || roundName(item.ref) === round) &&
        (selected || !stage || stageName(item.ref) === stage),
    ) ?? [];
  const offset = requestedOffset < matching.length ? requestedOffset : 0;
  const visible = matching.slice(offset, offset + 50);
  return (
    <div className="section-stack">
      <div className="section-heading">
        <div>
          <h2>{selected ? 'Measurement details' : 'Evaluations'}</h2>
        </div>
        {candidate ? (
          <a href={route(id, 'measurements')} className="quiet-button">
            Clear candidate filter
          </a>
        ) : null}
      </div>
      {selected ? (
        <p className="filter-note">
          <a className="text-link" href={route(id, 'measurements', candidate)}>
            Show all measurements
          </a>
        </p>
      ) : null}
      {candidate ? (
        <p className="filter-note">
          Candidate:{' '}
          <code title={candidate}>{labels.candidate(candidate)}</code>
        </p>
      ) : null}
      {!selected ? (
        <div className="chart-controls">
          <label>
            Round{' '}
            <select
              value={round}
              onChange={(event) => {
                setRound(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All rounds</option>
              {rounds.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            {labels.isHarness ? 'Version' : 'Evaluation set'}{' '}
            <select
              value={stage}
              onChange={(event) => {
                setStage(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">
                {labels.isHarness ? 'All versions' : 'All sets'}
              </option>
              {stages.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <Feedback {...result} />
      {result.data ? (
        <>
          {matching.length === 0 ? (
            <Card>
              <CardContent>
                <p className="empty-state">
                  {selected
                    ? 'The linked measurement is not in the recorded measurements.'
                    : `No measurements recorded${candidate ? ' for this candidate' : ''}.`}
                </p>
              </CardContent>
            </Card>
          ) : !selected ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evaluation</TableHead>
                  <TableHead>
                    {labels.isHarness ? 'Version' : 'Candidate'}
                  </TableHead>
                  {labels.isHarness ? <TableHead>Task</TableHead> : null}
                  <TableHead>
                    {metric ? metricLabel(metric) : 'Score'}
                  </TableHead>
                  {inference ? (
                    <>
                      <TableHead>TPOT P90 (ms)</TableHead>
                      <TableHead>TTFT P90 (ms)</TableHead>
                    </>
                  ) : null}
                  <TableHead>Status</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Finished</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((measurement) => (
                  <TableRow key={measurement.ref}>
                    <TableCell>
                      <a
                        className="text-link"
                        title={measurement.ref}
                        href={route(id, 'measurements', undefined, undefined, {
                          measurement: measurement.ref,
                        })}
                      >
                        {labels.evaluation(measurement.ref)}
                      </a>
                    </TableCell>
                    <TableCell>
                      <span>
                        {labels.isHarness
                          ? (labels.harness(measurement.ref)?.variant ??
                            labels.candidate(measurement.candidateRef))
                          : labels.candidate(measurement.candidateRef)}
                      </span>
                    </TableCell>
                    {labels.isHarness ? (
                      <TableCell>
                        {labels
                          .task(measurement.ref)
                          ?.replace(/^workbuddy\//, '') ?? '—'}
                      </TableCell>
                    ) : null}
                    <TableCell>
                      {!metric || metricValue(measurement, metric) === null
                        ? '—'
                        : scoreLabel(metricValue(measurement, metric)!)}
                    </TableCell>
                    {inference
                      ? ['tpotP90', 'ttftP90'].map((name) => {
                          const metric = measurement.metrics.find(
                            (item) => item.name === name,
                          );
                          const value =
                            measurement.status === 'succeeded' &&
                            metric?.status === 'available'
                              ? metric.values.value
                              : null;
                          return (
                            <TableCell key={name}>
                              {typeof value === 'number'
                                ? scoreLabel(value)
                                : '—'}
                            </TableCell>
                          );
                        })
                      : null}
                    <TableCell>
                      <Status value={measurement.status} />
                    </TableCell>
                    <TableCell>{measurement.coverage}</TableCell>
                    <TableCell>
                      <Timestamp value={measurement.finishedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            visible.map((measurement) => (
              <Card key={measurement.ref}>
                <CardHeader>
                  <div className="section-heading">
                    <h3 title={measurement.ref}>
                      {labels.evaluation(measurement.ref)}
                    </h3>
                    <Status value={measurement.status} />
                  </div>
                  {labels.task(measurement.ref) ? (
                    <p className="muted harness-task-label">
                      {labels.task(measurement.ref)}
                    </p>
                  ) : null}
                  <dl className="facts">
                    <dt>Candidate</dt>
                    <dd>
                      <span>{labels.candidate(measurement.candidateRef)}</span>
                    </dd>
                    <dt>Evaluation call</dt>
                    <dd>
                      <a
                        className="text-link"
                        href={route(id, 'calls', undefined, undefined, {
                          call: measurement.callId,
                        })}
                      >
                        View call →
                      </a>
                    </dd>
                    <dt>Coverage</dt>
                    <dd>{measurement.coverage}</dd>
                    <dt>Comparison key</dt>
                    <dd>
                      {measurement.comparisonKey ??
                        'Unknown — comparability not established'}
                    </dd>
                    <dt>Finished</dt>
                    <dd>
                      <Timestamp value={measurement.finishedAt} />
                    </dd>
                  </dl>
                </CardHeader>
                <CardContent>
                  <MeasurementMetrics metrics={measurement.metrics} />
                  <h3>Task metrics</h3>
                  <Feedback {...taskRecords} />
                  {taskRecords.data?.items.some(
                    (item) => item.ref === measurement.ref && item.item,
                  ) ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Task</TableHead>
                          <TableHead>Result</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {taskRecords.data.items
                          .filter(
                            (item) => item.ref === measurement.ref && item.item,
                          )
                          .map((item) => (
                            <TableRow
                              key={JSON.stringify([item.ref, item.item!.id])}
                            >
                              <TableCell>
                                {item.item!.subjectId.replace(
                                  /^workbuddy\//,
                                  '',
                                )}
                              </TableCell>
                              <TableCell>
                                <MeasurementMetrics metrics={item.metrics} />
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  ) : taskRecords.data ? (
                    <p className="muted">
                      No per-task metrics were recorded. Aggregate metrics are
                      shown above.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
          <Pagination
            page={{
              items: visible,
              total: matching.length,
              nextOffset: offset + 50 < matching.length ? offset + 50 : null,
            }}
            offset={offset}
            setOffset={setOffset}
          />
        </>
      ) : null}
    </div>
  );
}
