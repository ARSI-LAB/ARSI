import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from 'recharts';
import type { MeasurementSummary } from '../../../api/observation-client';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '../../../components/ui/chart';
import { useRoundLabels } from '../round-labels';
import { primaryScore, roundAverage } from '../measurement-score';
import { scoreLabel } from '../record-identifiers';

export function HarnessAverage({
  evaluations,
}: {
  evaluations: MeasurementSummary[];
}): React.JSX.Element {
  const labels = useRoundLabels();
  const rounds = [
    ...new Set(
      evaluations.flatMap((item) => {
        const stage = labels.harness(item.ref);
        return stage ? [stage.round] : [];
      }),
    ),
  ];
  const points = ['Base', 'Invariant', 'Domain', 'Composed'].map((variant) => {
    const groups = rounds.map((round) =>
      evaluations.filter((item) => {
        const stage = labels.harness(item.ref);
        return stage?.round === round && stage.variant === variant;
      }),
    );
    const value = roundAverage(groups);
    const count = groups.filter((items) =>
      items.some((item) => primaryScore(item) !== null),
    ).length;
    return {
      variant,
      value,
      displayValue: value === null ? '—' : scoreLabel(value),
      coverage: `${count} / ${rounds.length} rounds`,
    };
  });
  return (
    <div className="score-chart-scroll">
      <ChartContainer
        config={{ value: { label: 'Average score', color: 'var(--brand)' } }}
        className="observation-chart"
        style={{ minWidth: 420 }}
        aria-label="Average scores across all recorded rounds"
      >
        <BarChart
          accessibilityLayer
          data={points}
          margin={{ top: 46, right: 36, left: 0, bottom: 24 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          <XAxis
            dataKey="variant"
            tickLine={false}
            axisLine={false}
            interval={0}
          />
          <YAxis
            tickFormatter={scoreLabel}
            domain={[0, 'auto']}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) =>
                  typeof value === 'number' ? scoreLabel(value) : String(value)
                }
              />
            }
          />
          <Bar
            dataKey="value"
            fill="var(--color-value)"
            radius={[4, 4, 0, 0]}
            maxBarSize={56}
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
              dataKey="coverage"
              position="top"
              offset={28}
              fill="var(--muted-foreground)"
              fontSize={10}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}
