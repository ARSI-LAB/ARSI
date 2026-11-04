import { buildRoundLabels, harnessStage } from './round-label-model';
import React, { createContext, useContext, useMemo } from 'react';
import {
  parseCalls,
  type CallSummary,
  type MeasurementSummary,
  type Page,
  parseCandidates,
  parseMeasurements,
  parseMetricRecords,
} from '../../api/observation-client';
import { useAllObservations, type QueryState } from './use-observation';

const LabelContext = createContext<ReturnType<typeof buildRoundLabels>>({
  candidate: () => '…',
  evaluation: (ref) => `Evaluation ${ref}`,
  harness: () => null,
  task: () => null,
  evaluationGroup: () => null,
  isHarness: false,
});
const RecordsContext = createContext<{
  calls: QueryState<Page<CallSummary>>;
  measurements: QueryState<Page<MeasurementSummary>>;
} | null>(null);
export function useCallRecords(): NonNullable<
  React.ContextType<typeof RecordsContext>
> {
  const records = useContext(RecordsContext);
  if (!records) throw new Error('Call records require RoundLabels');
  return records;
}
export function RoundLabels({
  id,
  children,
  finished = false,
}: {
  id: string;
  finished?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const calls = useAllObservations(
    `/${encodeURIComponent(id)}/calls`,
    parseCalls,
    finished ? null : 15000,
  );
  const candidates = useAllObservations(
    `/${encodeURIComponent(id)}/candidates`,
    parseCandidates,
    finished ? null : 15000,
  );
  const measurements = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
    finished ? null : 15000,
  );
  const taskRecords = useAllObservations(
    calls.data?.items.some((call) => harnessStage(call.path))
      ? `/${encodeURIComponent(id)}/metric-observations`
      : null,
    parseMetricRecords,
    finished ? null : 15000,
  );
  const labels = useMemo(
    () =>
      buildRoundLabels(
        candidates.data?.items ?? [],
        calls.data?.items ?? [],
        measurements.data?.items ?? [],
        taskRecords.data?.items ?? [],
      ),
    [calls.data, candidates.data, measurements.data, taskRecords.data],
  );
  return (
    <RecordsContext.Provider value={{ calls, measurements }}>
      <LabelContext.Provider value={labels}>{children}</LabelContext.Provider>
    </RecordsContext.Provider>
  );
}
export function useRoundLabels(): ReturnType<typeof buildRoundLabels> {
  return useContext(LabelContext);
}
