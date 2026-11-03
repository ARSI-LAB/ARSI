import React from 'react';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { parseMeasurements } from '../../api/observation-client';
import { candidateLabel, evaluationOrdinals } from './record-identifiers';
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
  const requestedOffset = useRoute().offset ?? 0;
  const setOffset = (offset: number): void => replaceRouteSelection({ offset });
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
  );
  const ordinals = evaluationOrdinals(result.data?.items ?? []);
  const matching =
    result.data?.items.filter(
      (item) =>
        (!selected || item.ref === selected) &&
        (!candidate || item.candidateRef === candidate),
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
          Measurement: <code>{selected}</code>{' '}
          <a className="text-link" href={route(id, 'measurements', candidate)}>
            Show all measurements
          </a>
        </p>
      ) : null}
      {candidate ? (
        <p className="filter-note">
          Candidate: <code title={candidate}>{candidateLabel(candidate)}</code>
        </p>
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
                  <TableHead>Candidate</TableHead>
                  <TableHead>Status</TableHead>
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
                        Evaluation #{ordinals.get(measurement.ref)}
                      </a>
                    </TableCell>
                    <TableCell>
                      <a
                        className="text-link"
                        title={measurement.candidateRef}
                        href={route(id, 'candidates', measurement.candidateRef)}
                      >
                        {candidateLabel(measurement.candidateRef)}
                      </a>
                    </TableCell>
                    <TableCell>
                      <Status value={measurement.status} />
                    </TableCell>
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
                      Evaluation #{ordinals.get(measurement.ref)}
                    </h3>
                    <Status value={measurement.status} />
                  </div>
                  <dl className="facts">
                    <dt>Candidate</dt>
                    <dd>
                      <a
                        className="text-link"
                        title={measurement.candidateRef}
                        href={route(id, 'candidates', measurement.candidateRef)}
                      >
                        {candidateLabel(measurement.candidateRef)}
                      </a>
                    </dd>
                    <dt>Evaluation call</dt>
                    <dd>
                      <a
                        className="text-link"
                        href={route(id, 'calls', undefined, undefined, {
                          call: measurement.callId,
                        })}
                      >
                        {measurement.callId}
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
                  {measurement.metrics.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          <TableHead>Observation</TableHead>
                          <TableHead>Unit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {measurement.metrics.map((metric) => (
                          <TableRow key={metric.name}>
                            <TableCell>
                              <strong>{metric.name}</strong>
                              <p className="muted">{metric.description}</p>
                            </TableCell>
                            <TableCell>
                              {metric.status === 'available' ? (
                                Object.entries(metric.values).map(
                                  ([name, value]) => (
                                    <div key={name}>
                                      {name}:{' '}
                                      <strong>
                                        {value === null
                                          ? 'Not recorded'
                                          : value.toLocaleString(undefined, {
                                              maximumSignificantDigits: 21,
                                            })}
                                      </strong>
                                    </div>
                                  ),
                                )
                              ) : (
                                <span>
                                  {metric.status}:{' '}
                                  {metric.reason ?? 'No value recorded'}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>{metric.unit}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p>No metrics recorded.</p>
                  )}
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
