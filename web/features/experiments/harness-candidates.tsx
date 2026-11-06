import React from 'react';
import type { CandidateSummary } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute } from '../../app/use-route';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useCallRecords, useRoundLabels } from './round-labels';
import { primaryScore } from './measurement-score';
import { scoreLabel } from './record-identifiers';

export function HarnessCandidates({
  id,
  candidates,
  selected,
}: {
  id: string;
  candidates: CandidateSummary[];
  selected?: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const { candidateCell } = useRoute();
  let selectionShown = false;
  const { measurements } = useCallRecords();
  const records = measurements.data?.items ?? [];
  const rounds = [
    ...new Set(
      [
        ...records.map((m) => labels.harness(m.ref)?.round),
        ...candidates.map((c) => labels.candidateStage(c.ref)?.round),
      ].filter((r): r is string => !!r),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <>
      <Table className="harness-candidates-table">
        <TableHeader>
          <TableRow>
            <TableHead>Round / Task</TableHead>
            {['Base', 'Invariant', 'Domain', 'Composed'].map((v) => (
              <TableHead key={v}>{v}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rounds.map((round) => {
            const evaluations = records.filter(
              (m) => labels.harness(m.ref)?.round === round,
            );
            const tasks = [
              ...new Set(
                evaluations
                  .map((m) => labels.task(m.ref))
                  .filter((t): t is string => !!t),
              ),
            ];
            return (
              <TableRow key={round}>
                <TableCell>
                  <strong className="harness-round-label">{round}</strong>
                  <div className="harness-result-task muted">
                    {tasks.map((task) => (
                      <span key={task}>{task.replace(/^workbuddy\//, '')}</span>
                    ))}
                  </div>
                </TableCell>
                {(['Base', 'Invariant', 'Domain', 'Composed'] as const).map(
                  (variant) => {
                    const matching = evaluations.filter(
                      (m) => labels.harness(m.ref)?.variant === variant,
                    );
                    const refs = [
                      ...new Set([
                        ...matching.map((m) => m.candidateRef),
                        ...candidates
                          .filter((c) => {
                            const stage = labels.candidateStage(c.ref);
                            return (
                              stage?.round === round &&
                              stage.variant === variant
                            );
                          })
                          .map((c) => c.ref),
                      ]),
                    ];
                    return (
                      <TableCell key={variant}>
                        <div className="harness-score-list">
                          {refs.length
                            ? refs.map((ref, index) => {
                                const cell = `${round}:${variant}:${ref}`;
                                const isSelected =
                                  selected === ref &&
                                  !selectionShown &&
                                  (!candidateCell || candidateCell === cell);
                                if (isSelected) selectionShown = true;
                                return (
                                  <a
                                    key={ref}
                                    className="harness-version"
                                    aria-current={
                                      isSelected ? 'true' : undefined
                                    }
                                    aria-label={`Inspect ${round} ${variant}${refs.length > 1 ? ` ${index + 1}` : ''}`}
                                    href={route(
                                      id,
                                      'candidates',
                                      ref,
                                      undefined,
                                      { candidateCell: cell },
                                    )}
                                  >
                                    {refs.length > 1 ? (
                                      <span className="muted">
                                        Candidate {index + 1}
                                      </span>
                                    ) : null}
                                    <strong>
                                      {matching
                                        .filter((m) => m.candidateRef === ref)
                                        .map((m) => {
                                          const score = primaryScore(m);
                                          return score === null
                                            ? '—'
                                            : scoreLabel(score);
                                        })
                                        .join(' / ') || 'Not evaluated'}
                                    </strong>
                                  </a>
                                );
                              })
                            : '—'}
                        </div>
                      </TableCell>
                    );
                  },
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
