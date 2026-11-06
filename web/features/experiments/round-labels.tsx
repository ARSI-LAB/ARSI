import { Feedback } from '../../components/observation-feedback';
import { buildRoundLabels } from './round-label-model';
import { comparisonPolicy } from './policy-presentation';
import React, { createContext, useContext, useMemo } from 'react';
import {
  parseCalls,
  parseDetails,
  type CallSummary,
  type MeasurementSummary,
  type Page,
  parseCandidates,
  parseMeasurements,
  parseMetricRecords,
} from '../../api/observation-client';
import {
  useAllObservations,
  useObservation,
  type QueryState,
} from './use-observation';

const LabelContext = createContext<ReturnType<typeof buildRoundLabels>>({
  candidate: () => '…',
  evaluation: (ref) => `Evaluation ${ref}`,
  harness: () => null,
  task: () => null,
  evaluationGroup: () => null,
  isHarness: false,
  candidateStage: () => null,
});
const RecordsContext = createContext<{
  labelsLoading: boolean;
  labelsError: string;
  refreshLabels: () => void;
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
  const details = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
    finished ? null : 15000,
    finished,
  );
  const policy = useMemo(
    () => comparisonPolicy(details.data?.configuration),
    [details.data],
  );
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
    policy !== null ? `/${encodeURIComponent(id)}/metric-observations` : null,
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
        policy,
      ),
    [calls.data, candidates.data, measurements.data, taskRecords.data, policy],
  );
  return (
    <RecordsContext.Provider
      value={{
        calls,
        measurements,
        labelsLoading:
          details.loading ||
          calls.loading ||
          candidates.loading ||
          measurements.loading ||
          taskRecords.loading,
        labelsError:
          details.error ||
          calls.error ||
          candidates.error ||
          measurements.error ||
          taskRecords.error,
        refreshLabels: () => {
          details.refresh();
          calls.refresh();
          candidates.refresh();
          measurements.refresh();
          taskRecords.refresh();
        },
      }}
    >
      <LabelContext.Provider value={labels}>{children}</LabelContext.Provider>
    </RecordsContext.Provider>
  );
}
export function useRoundLabels(): ReturnType<typeof buildRoundLabels> {
  return useContext(LabelContext);
}

/** Do not select a presentation from incomplete policy/task associations. */
export function PresentationReady({
  children,
  required = true,
}: {
  children: React.ReactNode;
  required?: boolean;
}): React.JSX.Element {
  const records = useCallRecords();
  if (required && (records.labelsLoading || records.labelsError))
    return (
      <Feedback
        loading={records.labelsLoading}
        error={records.labelsError}
        refresh={records.refreshLabels}
      />
    );
  return <>{children}</>;
}
