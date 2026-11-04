import React from 'react';
import type { CandidateSummary } from '../../api/observation-client';
import { route } from '../../app/routing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useCallRecords, useRoundLabels } from './round-labels';
import { harnessStage } from './round-label-model';
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
  const { measurements } = useCallRecords();
  const records = measurements.data?.items ?? [];
  const rounds = [
    ...new Set(
      [
        ...records.map((m) => labels.harness(m.ref)?.round),
        ...candidates.map((c) => harnessStage(c.originPath)?.round),
      ].filter((r): r is string => !!r),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <Table>
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
                          const stage = harnessStage(c.originPath);
                          return (
                            stage?.round === round && stage.variant === variant
                          );
                        })
                        .map((c) => c.ref),
                    ]),
                  ];
                  return (
                    <TableCell key={variant}>
                      <div className="harness-score-list">
                        {refs.length
                          ? refs.map((ref, index) => (
                              <a
                                key={ref}
                                className="harness-version"
                                aria-current={
                                  selected === ref ? 'true' : undefined
                                }
                                aria-label={`Inspect ${round} ${variant}${refs.length > 1 ? ` ${index + 1}` : ''}`}
                                href={route(id, 'candidates', ref)}
                              >
                                <strong>
                                  {variant}
                                  {refs.length > 1 ? ` ${index + 1}` : ''}
                                </strong>
                                <span>
                                  {matching
                                    .filter((m) => m.candidateRef === ref)
                                    .map((m) => {
                                      const score = primaryScore(m);
                                      return score === null
                                        ? '—'
                                        : scoreLabel(score);
                                    })
                                    .join(' / ') || 'Not evaluated'}
                                </span>
                              </a>
                            ))
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
  );
}
