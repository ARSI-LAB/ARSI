import React, { useState } from 'react';
import type {
  CandidateSummary,
  MeasurementSummary,
  ResultReference,
} from '../../api/observation-client';
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
import { useRoundLabels } from './round-labels';
import { inferenceMetric, inferenceSummary } from './inference-summary';

const number = (value: number | null): string =>
  value === null
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function InferenceReport({
  id,
  measurements,
  candidates,
  resultReferences,
}: {
  id: string;
  measurements: MeasurementSummary[];
  candidates: CandidateSummary[];
  resultReferences?: ResultReference[];
}): React.JSX.Element | null {
  const [condition, setCondition] = useState('');
  const labels = useRoundLabels();
  const summary = inferenceSummary(measurements, candidates, condition);
  if (!summary) return null;
  const { group, groups, points, best, measurement, baselineValue, change } =
    summary;
  const values = points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const low = Math.max(0, Math.min(...values) * 0.85);
  const high = Math.max(...values) * 1.08 || 1;
  const x = (index: number): number =>
    74 + (index * 740) / Math.max(1, points.length - 1);
  const y = (value: number): number =>
    218 - ((value - low) / (high - low)) * 180;
  const detail = (ref: string): string =>
    route(id, 'measurements', undefined, undefined, { measurement: ref });
  const ordered = [...measurements].sort(
    (a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
      a.ref.localeCompare(b.ref),
  );
  const failed = measurements.filter(
    (item) => item.status !== 'succeeded',
  ).length;
  return (
    <div className="inference-report section-stack">
      <div className="results-heading">
        <div>
          <h2>Inference performance</h2>
          <p>
            Output throughput, latency and the evidence behind each candidate.
          </p>
        </div>
        <a className="quiet-button" href={route(id, 'learning')}>
          Explore Reflection & Memory
        </a>
      </div>
      {groups.length > 1 ? (
        <label className="inference-condition">
          Comparison conditions
          <select
            value={group.key}
            onChange={(event) => setCondition(event.target.value)}
          >
            {groups.map((item, index) => (
              <option key={item.key} value={item.key}>
                Condition {index + 1} · {item.unit} ·{' '}
                {item.comparisonKey?.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <section className="inference-scoreboard" aria-label="Throughput summary">
        <div className="inference-best">
          <span>Best measured output throughput</span>
          <div className="inference-value">
            {number(best.value)} <small>{group.unit}</small>
          </div>
          <a href={detail(best.measurementRef)}>
            {labels.candidate(best.candidateRef)} · View measurement
          </a>
        </div>
        <div className="inference-stat">
          <span>Compared with baseline</span>
          <strong
            data-trend={
              change === null
                ? undefined
                : change > 0
                  ? 'improved'
                  : change < 0
                    ? 'regressed'
                    : 'unchanged'
            }
          >
            {change === null
              ? '—'
              : `${change >= 0 ? '+' : ''}${number(change)}%`}
          </strong>
          <small>
            {baselineValue === null
              ? 'No unique comparable baseline'
              : `${number(baselineValue)} ${group.unit} baseline`}
          </small>
        </div>
        <div className="inference-stat">
          <span>TPOT P90 at best throughput</span>
          <strong>
            {number(inferenceMetric(measurement, 'tpotP90'))} <small>ms</small>
          </strong>
          <small>From the same evaluation</small>
        </div>
      </section>
      <div className="inference-analysis">
        <Card className="inference-trajectory">
          <CardHeader>
            <div className="section-heading">
              <div>
                <h2>Throughput trajectory</h2>
                <p>Recorded evaluations in execution order</p>
              </div>
              <span className="inference-legend">
                <i />
                Output throughput
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <svg
              className="inference-chart"
              viewBox="0 0 860 270"
              role="img"
              aria-label={`Output throughput across ${points.length} evaluations. Best ${number(best.value)} ${group.unit}. Individual measurements are linked below.`}
            >
              {[0, 1, 2, 3].map((tick) => {
                const value = low + ((high - low) * tick) / 3;
                return (
                  <g key={tick}>
                    <line
                      x1="74"
                      x2="814"
                      y1={y(value)}
                      y2={y(value)}
                      className="inference-grid"
                    />
                    <text x="60" y={y(value) + 4} textAnchor="end">
                      {Math.round(value).toLocaleString()}
                    </text>
                  </g>
                );
              })}
              {baselineValue !== null &&
              baselineValue >= low &&
              baselineValue <= high ? (
                <line
                  x1="74"
                  x2="814"
                  y1={y(baselineValue)}
                  y2={y(baselineValue)}
                  className="inference-baseline"
                />
              ) : null}
              {points.map((point, index) => {
                const previous = points[index - 1];
                return point.value === null ? null : (
                  <g key={point.observationKey}>
                    {previous?.value != null ? (
                      <line
                        x1={x(index - 1)}
                        y1={y(previous.value)}
                        x2={x(index)}
                        y2={y(point.value)}
                        className="inference-line"
                      />
                    ) : null}
                    <circle
                      cx={x(index)}
                      cy={y(point.value)}
                      r={point === best ? 6 : 4}
                      className={
                        point === best
                          ? 'inference-dot is-best'
                          : 'inference-dot'
                      }
                    >
                      <title>
                        {labels.evaluation(point.measurementRef)}:{' '}
                        {number(point.value)} {group.unit}
                      </title>
                    </circle>
                    {index % Math.max(1, Math.ceil(points.length / 9)) === 0 ||
                    index === points.length - 1 ? (
                      <text x={x(index)} y="247" textAnchor="middle">
                        {point.sequence}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              <text x="444" y="268" textAnchor="middle">
                Evaluation
              </text>
            </svg>
            <p className="inference-chart-note">
              {values.length} complete measurements under the selected
              conditions.{' '}
              {baselineValue === null
                ? ''
                : 'Dashed line: comparable baseline.'}{' '}
              Highest throughput does not establish acceptance or repeatability.
            </p>
          </CardContent>
        </Card>
        <Card className="inference-evidence">
          <CardHeader>
            <h2>Evaluation record</h2>
          </CardHeader>
          <CardContent>
            <dl>
              <div>
                <dt>Total evaluations</dt>
                <dd>{measurements.length}</dd>
              </div>
              <div>
                <dt>Succeeded</dt>
                <dd>{measurements.length - failed}</dd>
              </div>
              <div>
                <dt>Other outcomes</dt>
                <dd>{failed}</dd>
              </div>
            </dl>
            <div className="inference-delivery">
              <h3>Saved result</h3>
              {resultReferences ? (
                <>
                  {resultReferences
                    .filter(
                      (reference) =>
                        reference.kind === 'candidate' &&
                        reference.path === '/candidateRef',
                    )
                    .map((reference) => (
                      <a
                        key={reference.path}
                        href={route(id, 'candidates', reference.ref)}
                      >
                        Returned candidate: {labels.candidate(reference.ref)}
                      </a>
                    ))}
                  <details className="inference-output-references">
                    <summary>
                      {resultReferences.length} output references
                    </summary>
                    <div>
                      {resultReferences.map((reference) => (
                        <a
                          key={`${reference.path}:${reference.ref}`}
                          href={
                            reference.kind === 'candidate'
                              ? route(id, 'candidates', reference.ref)
                              : detail(reference.ref)
                          }
                        >
                          <span>
                            {reference.kind === 'candidate'
                              ? labels.candidate(reference.ref)
                              : labels.evaluation(reference.ref)}
                          </span>
                          <code>{reference.path}</code>
                        </a>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <a href={route(id, 'results')}>View saved result</a>
              )}
            </div>
            <a className="text-link" href={route(id, 'candidates')}>
              Inspect candidate changes
            </a>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div className="section-heading">
            <div>
              <h2>Evaluation history</h2>
              <p>
                All recorded conditions and outcomes; inspect a row for full
                metrics.
              </p>
            </div>
            <span className="inference-count">
              {measurements.length} evaluations
            </span>
          </div>
        </CardHeader>
        <CardContent className="inference-table-content">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Evaluation</TableHead>
                <TableHead>Candidate</TableHead>
                <TableHead>Output tokens/s</TableHead>
                <TableHead>TPOT P90 · ms</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((item) => (
                <TableRow
                  key={item.ref}
                  data-selected={item.ref === best.measurementRef}
                >
                  <TableCell>
                    <a className="text-link" href={detail(item.ref)}>
                      {labels.evaluation(item.ref)}
                    </a>
                  </TableCell>
                  <TableCell>
                    <a href={route(id, 'candidates', item.candidateRef)}>
                      {labels.candidate(item.candidateRef)}
                    </a>
                    {item.ref === best.measurementRef ? (
                      <span className="inference-best-tag">Peak</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <strong>
                      {number(inferenceMetric(item, 'outputThroughput'))}
                    </strong>
                  </TableCell>
                  <TableCell>
                    {number(inferenceMetric(item, 'tpotP90'))}
                  </TableCell>
                  <TableCell>{item.coverage}</TableCell>
                  <TableCell>
                    <Status value={item.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
