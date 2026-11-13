import { HarnessAverage } from './harness-average';
import { useRoundLabels } from '../round-labels';
import React, { useMemo, useEffect, useRef } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  LabelList,
  XAxis,
  YAxis,
} from 'recharts';
import {
  type MetricRecord,
  type MeasurementSummary,
} from '../../../api/observation-client';
import { ChartContainer, ChartTooltip } from '../../../components/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { format } from './chart-controls';
import { route } from '../../../app/routing';
import { useRoute, replaceRouteSelection } from '../../../app/use-route';
import { primaryMetric as selectPrimaryMetric } from '../measurement-score';
import { scoreLabel } from '../record-identifiers';
import { scoreGroups, scorePoints, type ScorePoint } from './metric-data';
const scoreConfig = {
  value: { label: 'Recorded value', color: 'var(--brand)' },
};
export function ScorePlot({
  measurements,
  evaluations,
  roots,
  finals,
  comparison,
  candidate,
  id,
}: {
  measurements: MetricRecord[];
  evaluations: MeasurementSummary[];
  roots: string[];
  finals: string[];
  comparison: boolean;
  candidate?: string;
  id: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const selection = useRoute();
  const selectedPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selection.point)
      selectedPanel.current?.scrollIntoView({ block: 'nearest' });
  }, [selection.point]);
  const filteredMeasurements = useMemo(
    () =>
      candidate
        ? measurements.filter((item) => item.candidateRef === candidate)
        : measurements,
    [measurements, candidate],
  );
  const groups = useMemo(
    () => scoreGroups(filteredMeasurements),
    [filteredMeasurements],
  );
  const scope = selection.scope ?? '';
  const scopes = [
    ...new Map(
      groups.map((group) => [group.scopeKey, group.subject]),
    ).entries(),
  ];
  const activeScope =
    !comparison && scopes.some(([key]) => key === 'aggregate')
      ? 'aggregate'
      : scopes.some(([key]) => key === scope)
        ? scope
        : scopes[0]?.[0];
  const scopedGroups = groups.filter((group) => group.scopeKey === activeScope);
  const metric = selection.metric ?? '';
  const metricKey = (item: ReturnType<typeof scoreGroups>[number]): string =>
    JSON.stringify([item.name, item.unit]);
  const metrics = [
    ...new Map(scopedGroups.map((item) => [metricKey(item), item])).entries(),
  ];
  const preferredName = selectPrimaryMetric(
    filteredMeasurements.flatMap((item) => item.metrics),
  )?.name;
  const primaryMetric =
    metrics.find(([, item]) => item.name === preferredName) ??
    metrics.find(([, item]) => item.name === 'meanReward') ??
    metrics.find(([, item]) => item.name === 'score') ??
    metrics.find(([, item]) => item.statistics.includes('value')) ??
    metrics[0];
  const activeMetric = !comparison
    ? primaryMetric?.[0]
    : metrics.some(([key]) => key === metric)
      ? metric
      : primaryMetric?.[0];
  const conditions = scopedGroups.filter(
    (item) => metricKey(item) === activeMetric,
  );
  const average =
    labels.isHarness &&
    !comparison &&
    (!selection.condition || selection.condition === 'average');
  const chosen = selection.condition ?? '',
    stat = comparison ? (selection.statistic ?? 'value') : 'value';
  const conditionName = (item: (typeof conditions)[number]): string => {
    const points = scorePoints(
      filteredMeasurements,
      item,
      item.statistics[0] ?? 'value',
      evaluations,
    );
    const harnessGroup = labels.evaluationGroup(
      points.map((point) => point.measurementRef),
    );
    if (harnessGroup) return harnessGroup;
    const names = points.map((point) =>
      labels.evaluation(point.measurementRef),
    );
    if (
      names.length &&
      names.every((name) => /Validation|Baseline evaluation/.test(name))
    )
      return 'Validation';
    if (names.length && names.every((name) => /Training/.test(name)))
      return 'Training';
    if (names.length && names.every((name) => /Final test/.test(name)))
      return 'Final test';
    return 'Evaluation';
  };
  const conditionLabel = (item: (typeof conditions)[number]): string => {
    const stage = conditionName(item);
    const name = stage.startsWith('Round ')
      ? stage.split(' · ')[0]
      : stage === 'Validation'
        ? 'Validation set'
        : stage === 'Training'
          ? 'Optimization set'
          : stage;
    const siblings = conditions.filter(
      (other) => conditionName(other) === stage,
    );
    return (
      name +
      (siblings.length > 1 ? ` · ${siblings.indexOf(item) + 1}` : '') +
      (item.coverage !== 'complete' ? ' · partial' : '') +
      (item.comparisonKey === null ? ' · unknown conditions' : '')
    );
  };
  const group =
    conditions.find((item) => item.key === chosen) ??
    conditions.find((item) => conditionName(item) === 'Validation') ??
    conditions[0];
  const statistic = group?.statistics.includes(stat)
    ? stat
    : (group?.statistics[0] ?? 'value');
  const rows = useMemo(
    () =>
      group
        ? scorePoints(measurements, group, statistic, evaluations).filter(
            (point) => !candidate || point.candidateRef === candidate,
          )
        : [],
    [measurements, evaluations, group, statistic, candidate],
  );
  if (!group)
    return (
      <p className="empty-state">
        No numeric metrics recorded yet. Results appear after an evaluation
        records them.
      </p>
    );
  const window = rows.map((row) => ({
    ...row,
    candidateLabel: labels.candidate(row.candidateRef),
  }));
  const harnessComparison =
    rows.length > 0 && rows.every((row) => labels.harness(row.measurementRef));
  const barComparison = comparison || harnessComparison;
  const multipleHarnessRounds =
    new Set(rows.map((row) => labels.harness(row.measurementRef)?.round)).size >
    1;
  const finite = rows.filter((row) => row.value !== null);
  const domain: [number | 'auto', number | 'auto'] =
    group.unit === 'ratio' &&
    finite.every((row) => row.value! >= 0 && row.value! <= 1)
      ? [0, 1]
      : barComparison && finite.every((row) => row.value! >= 0)
        ? [0, 'auto']
        : barComparison && finite.every((row) => row.value! <= 0)
          ? ['auto', 0]
          : ['auto', 'auto'];
  const points = window.map((row) => ({
    ...row,
    axisLabel: harnessComparison
      ? multipleHarnessRounds
        ? labels.evaluation(row.measurementRef)
        : labels
            .evaluation(row.measurementRef)
            .split(' · ')
            .slice(1)
            .join(' · ')
      : labels
          .evaluation(row.measurementRef)
          .replace('Baseline evaluation', 'Baseline')
          .split(' · ')[0],
    displayValue: row.value === null ? '' : scoreLabel(row.value),
    roleLabel: [
      roots.includes(row.candidateRef) ? 'Root' : '',
      finals.includes(row.candidateRef)
        ? harnessComparison
          ? 'Delivered'
          : 'Final'
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  const selectedPoint = window.find(
    (row) => row.observationKey === selection.point,
  );
  const pointHref = (row: ScorePoint): string =>
    route(id, 'measurements', undefined, undefined, {
      measurement: row.measurementRef,
    });
  const pointFromShape = (raw: unknown): ScorePoint | undefined => {
    if (!raw || typeof raw !== 'object' || !('payload' in raw))
      return undefined;
    const payload = raw.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('observationKey' in payload) ||
      typeof payload.observationKey !== 'string'
    )
      return undefined;
    return window.find((row) => row.observationKey === payload.observationKey);
  };
  const pointName = (row: ScorePoint): string =>
    `${labels.evaluation(row.measurementRef)}${harnessComparison ? '' : ` · ${labels.candidate(row.candidateRef)}`} · ${row.value === null ? row.reason : `${scoreLabel(row.value)} ${group.unit}`}`;
  const renderDot = (raw: unknown): React.ReactElement => {
    const row = pointFromShape(raw);
    if (
      !row ||
      row.value === null ||
      !raw ||
      typeof raw !== 'object' ||
      !('cx' in raw) ||
      !('cy' in raw) ||
      typeof raw.cx !== 'number' ||
      typeof raw.cy !== 'number'
    )
      return <g />;
    const selected = selectedPoint?.observationKey === row.observationKey;
    return (
      <a
        href={pointHref(row)}
        aria-label={pointName(row)}
        aria-current={selected ? 'true' : undefined}
        className="score-point-link"
      >
        <title>{pointName(row)}</title>
        <circle cx={raw.cx} cy={raw.cy} r={22} fill="transparent" />
        <circle
          cx={raw.cx}
          cy={raw.cy}
          r={selected ? 7 : 5}
          fill="var(--brand)"
          stroke="var(--card)"
          strokeWidth={2}
        />
      </a>
    );
  };
  const renderBar = (raw: unknown): React.ReactElement => {
    const row = pointFromShape(raw);
    if (
      !row ||
      row.value === null ||
      !raw ||
      typeof raw !== 'object' ||
      !('x' in raw) ||
      !('y' in raw) ||
      !('width' in raw) ||
      !('height' in raw) ||
      typeof raw.x !== 'number' ||
      typeof raw.y !== 'number' ||
      typeof raw.width !== 'number' ||
      typeof raw.height !== 'number'
    )
      return <g />;
    const selected = selectedPoint?.observationKey === row.observationKey;
    return (
      <a
        href={pointHref(row)}
        aria-label={pointName(row)}
        aria-current={selected ? 'true' : undefined}
        className="score-point-link"
      >
        <title>{pointName(row)}</title>
        <rect
          x={raw.x}
          y={raw.y - 4}
          width={raw.width}
          height={Math.max(44, raw.height + 8)}
          fill="transparent"
        />
        <rect
          x={raw.x}
          y={raw.y}
          width={raw.width}
          height={raw.height}
          rx={4}
          fill="var(--brand)"
          stroke={selected ? 'var(--foreground)' : 'none'}
          strokeWidth={2}
        />
      </a>
    );
  };
  const tooltip = ({
    active,
    label,
  }: {
    active?: boolean;
    label?: unknown;
  }): React.JSX.Element | null => {
    if (!active) return null;
    const row = points.find((row) => row.axisLabel === String(label));
    return row ? (
      <div className="observation-tooltip">
        <strong>
          {harnessComparison
            ? labels.evaluation(row.measurementRef)
            : `${row.candidateLabel} · ${labels.evaluation(row.measurementRef)}`}
        </strong>
        <p>
          {row.value === null
            ? row.reason
            : `${scoreLabel(row.value)} ${group.unit}`}
        </p>
      </div>
    ) : null;
  };
  return (
    <div className="section-stack">
      <div
        className={comparison ? 'chart-controls' : 'overview-score-controls'}
      >
        {comparison && scopes.length > 1 ? (
          <label>
            Result scope
            <select
              value={activeScope}
              onChange={(event) => {
                replaceRouteSelection({
                  scope: event.target.value,
                  condition: undefined,
                  chartOffset: 0,
                  point: undefined,
                });
              }}
            >
              {scopes.map(([key, label], index) => (
                <option key={key} value={key}>
                  {label}
                  {scopes.filter(([, title]) => title === label).length > 1
                    ? ` · configuration ${index + 1}`
                    : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {comparison && metrics.length > 1 ? (
          <label>
            Metric
            <select
              value={activeMetric}
              onChange={(event) => {
                replaceRouteSelection({
                  metric: event.target.value,
                  condition: undefined,
                  statistic: undefined,
                  chartOffset: 0,
                  point: undefined,
                });
              }}
            >
              {metrics.map(([key, item]) => (
                <option key={key} value={key}>
                  {item.name === 'meanReward'
                    ? 'Average score'
                    : `${item.name} (${item.unit})`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>
            {group.name === 'meanReward'
              ? 'Average score'
              : `${group.name} (${group.unit})`}
          </p>
        )}
        {!comparison &&
        (conditions.length > 1 ||
          (labels.isHarness && conditions.length > 0)) ? (
          <div
            className="actions"
            role="group"
            aria-label={labels.isHarness ? 'Round' : 'Evaluation stage'}
          >
            {labels.isHarness ? (
              <button
                className="quiet-button"
                aria-pressed={average}
                onClick={() =>
                  replaceRouteSelection({
                    condition: 'average',
                    point: undefined,
                  })
                }
              >
                Average
              </button>
            ) : null}
            {conditions.map((item) => (
              <button
                key={item.key}
                title={conditionName(item)}
                className="quiet-button"
                aria-pressed={!average && item.key === group.key}
                onClick={() =>
                  replaceRouteSelection({
                    condition: item.key,
                    point: undefined,
                  })
                }
              >
                {conditionLabel(item)}
              </button>
            ))}
          </div>
        ) : conditions.length > 1 ? (
          <label>
            Evaluation conditions
            <select
              value={group.key}
              onChange={(event) => {
                replaceRouteSelection({
                  condition: event.target.value,
                  chartOffset: 0,
                  point: undefined,
                });
              }}
            >
              {conditions.map((item) => (
                <option key={item.key} value={item.key}>
                  {conditionLabel(item)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {comparison && group.statistics.length > 1 ? (
          <label>
            Statistic
            <select
              value={statistic}
              onChange={(event) => {
                replaceRouteSelection({
                  statistic: event.target.value,
                  chartOffset: 0,
                  point: undefined,
                });
              }}
            >
              {group.statistics.map((name) => (
                <option key={name} value={name}>
                  {name === 'value' ? 'Scalar value' : name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {average ? (
        <HarnessAverage evaluations={evaluations} />
      ) : (
        <>
          {harnessComparison &&
          labels
            .evaluationGroup(rows.map((row) => row.measurementRef))
            ?.includes(' · ') ? (
            <p className="muted harness-task-label">
              {labels
                .evaluationGroup(rows.map((row) => row.measurementRef))
                ?.split(' · ')
                .slice(1)
                .join(' · ')}
            </p>
          ) : null}
          {comparison && window.length > 1 && group.comparable ? (
            <div
              className="actions"
              role="group"
              aria-label="Display measurements"
            >
              <button
                className="quiet-button"
                aria-pressed={!comparison || selection.display !== 'values'}
                onClick={() => replaceRouteSelection({ display: 'chart' })}
              >
                Chart
              </button>
              <button
                className="quiet-button"
                aria-pressed={comparison && selection.display === 'values'}
                onClick={() => replaceRouteSelection({ display: 'values' })}
              >
                Values
              </button>
            </div>
          ) : null}
          {group.coverage !== 'complete' && !comparison ? (
            <p className="filter-note">
              Incomplete coverage. Observations are not assumed comparable.
            </p>
          ) : null}
          {comparison && !group.comparable ? (
            <p className="empty-state">
              These observations are not comparable. Individual recorded values
              are shown below.
            </p>
          ) : null}
          {window.length === 1 ? (
            <div className="section-stack">
              <h3>
                {labels.evaluation(window[0]!.measurementRef)} ·{' '}
                {window[0]!.candidateLabel}
              </h3>
              {window[0]!.value === null ? (
                <p className="empty-state">{window[0]!.reason}</p>
              ) : (
                <p>
                  <strong className="stat-number">
                    {scoreLabel(window[0]!.value)}
                  </strong>{' '}
                  {group.unit}
                </p>
              )}
              <div className="actions">
                <a
                  className="text-link"
                  href={route(id, 'candidates', window[0]!.candidateRef)}
                >
                  {window[0]!.candidateLabel} →
                </a>
                <a
                  className="text-link"
                  href={route(id, 'measurements', undefined, undefined, {
                    measurement: window[0]!.measurementRef,
                  })}
                >
                  {labels.evaluation(window[0]!.measurementRef)} →
                </a>
                <a
                  className="text-link"
                  href={route(id, 'calls', undefined, undefined, {
                    call: window[0]!.callId,
                  })}
                >
                  View call →
                </a>
              </div>
            </div>
          ) : (!comparison || selection.display !== 'values') &&
            (!comparison || group.comparable) &&
            window.some((row) => row.value !== null) ? (
            <div
              className="score-chart-scroll"
              tabIndex={0}
              role="region"
              aria-label="Evaluation chart; scroll horizontally for more candidates"
            >
              <div
                style={{
                  minWidth: Math.max(420, points.length * 80),
                }}
              >
                <ChartContainer
                  config={scoreConfig}
                  className="observation-chart"
                  aria-label={
                    barComparison
                      ? 'Candidate score comparison'
                      : 'Metric history by evaluation order'
                  }
                >
                  {barComparison ? (
                    <BarChart
                      accessibilityLayer
                      data={points}
                      margin={{ top: 46, right: 36, left: 0, bottom: 24 }}
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 5" />
                      <XAxis
                        dataKey="axisLabel"
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis
                        domain={domain}
                        tickLine={false}
                        axisLine={false}
                        width={64}
                        tickFormatter={format}
                      />
                      <ChartTooltip content={tooltip} />
                      <Bar
                        dataKey="value"
                        fill="var(--color-value)"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={56}
                        isAnimationActive={false}
                        shape={renderBar}
                      >
                        <LabelList
                          dataKey="displayValue"
                          position="top"
                          offset={10}
                          fill="var(--foreground)"
                          fontSize={12}
                        />
                        <LabelList
                          dataKey="roleLabel"
                          position="top"
                          offset={28}
                          fill="var(--muted-foreground)"
                          fontSize={10}
                        />
                      </Bar>
                    </BarChart>
                  ) : (
                    <LineChart
                      accessibilityLayer
                      data={points}
                      margin={{ top: 46, right: 36, left: 0, bottom: 24 }}
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 5" />
                      <XAxis
                        dataKey="axisLabel"
                        tickLine={false}
                        axisLine={false}
                        padding={{ left: 32, right: 32 }}
                        interval={0}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis
                        domain={domain}
                        tickLine={false}
                        axisLine={false}
                        width={64}
                        tickFormatter={format}
                      />
                      <ChartTooltip content={tooltip} />
                      <Line
                        type="linear"
                        dataKey="value"
                        stroke="var(--color-value)"
                        strokeWidth={group.comparable ? 2.5 : 0}
                        dot={renderDot}
                        activeDot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      >
                        <LabelList
                          dataKey="displayValue"
                          position="top"
                          offset={10}
                          fill="var(--foreground)"
                          fontSize={12}
                        />
                        <LabelList
                          dataKey="roleLabel"
                          position="top"
                          offset={28}
                          fill="var(--muted-foreground)"
                          fontSize={10}
                        />
                      </Line>
                    </LineChart>
                  )}
                </ChartContainer>
              </div>
            </div>
          ) : (!comparison || selection.display !== 'values') &&
            finite.length === 0 ? (
            <p className="empty-state">
              No valid numeric observations for this metric.
            </p>
          ) : null}
          {!comparison ? (
            <a className="text-link" href={route(id, 'measurements')}>
              Explore tasks & metrics →
            </a>
          ) : null}
          {selectedPoint && window.length > 1 ? (
            <section
              className="selected-evaluation"
              ref={selectedPanel}
              aria-label="Selected evaluation"
            >
              <div className="section-heading">
                <h3>
                  {labels.evaluation(selectedPoint.measurementRef)} ·{' '}
                  {selectedPoint.candidateLabel}
                </h3>
                <strong>
                  {selectedPoint.value === null
                    ? selectedPoint.reason
                    : `${scoreLabel(selectedPoint.value)} ${group.unit}`}
                </strong>
              </div>
              <div className="actions">
                <a
                  className="text-link"
                  href={route(id, 'candidates', selectedPoint.candidateRef)}
                >
                  {selectedPoint.candidateLabel} →
                </a>
                <a
                  className="text-link"
                  href={route(id, 'measurements', undefined, undefined, {
                    measurement: selectedPoint.measurementRef,
                  })}
                >
                  {labels.evaluation(selectedPoint.measurementRef)} →
                </a>
                <a
                  className="text-link"
                  title={selectedPoint.callId}
                  href={route(id, 'calls', undefined, undefined, {
                    call: selectedPoint.callId,
                  })}
                >
                  View call →
                </a>
              </div>
            </section>
          ) : null}
          {window.length > 1 &&
          ((comparison && selection.display === 'values') ||
            (comparison && !group.comparable)) ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evaluation</TableHead>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Value ({group.unit})</TableHead>
                  <TableHead>Call</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {window.map((row) => (
                  <TableRow key={row.observationKey}>
                    <TableCell>
                      <a
                        className="text-link"
                        title={row.measurementRef}
                        aria-label={`View ${labels.evaluation(row.measurementRef)}`}
                        href={route(id, 'measurements', undefined, undefined, {
                          measurement: row.measurementRef,
                        })}
                      >
                        {labels.evaluation(row.measurementRef)}
                      </a>
                      {row.itemId ? <p>{row.itemId}</p> : null}
                    </TableCell>
                    <TableCell>
                      <a
                        className="text-link"
                        href={route(id, 'candidates', row.candidateRef)}
                      >
                        {row.candidateLabel}
                      </a>
                    </TableCell>
                    <TableCell>
                      {row.value === null ? row.reason : scoreLabel(row.value)}
                    </TableCell>
                    <TableCell>
                      <a
                        className="text-link"
                        title={row.callId}
                        href={route(id, 'calls', undefined, undefined, {
                          call: row.callId,
                        })}
                      >
                        View call
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
    </div>
  );
}
