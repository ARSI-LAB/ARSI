import React from 'react';
import {
  parseDetails,
  type CandidateSummary,
} from '../../api/observation-client';
import { useObservation } from './use-observation';
import { finalResults } from './final-results';
import { Feedback, Pagination } from '../../components/observation-feedback';
import { candidateScores } from './candidate-scores';
import { metricLabel } from './measurement-score';
import { scoreLabel } from './record-identifiers';
import { useRoundLabels, useCallRecords } from './round-labels';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';

export function CandidateRelations({
  id,
  candidates,
  selected,
}: {
  id: string;
  candidates: CandidateSummary[];
  selected?: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const { search, offset } = useRoute();
  const { measurements } = useCallRecords();
  const details = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
  );
  const all = measurements.data?.items ?? [];
  const validation = all.filter((item) =>
    /Validation|Baseline evaluation/.test(labels.evaluation(item.ref)),
  );
  const { group, scores } = candidateScores(
    all,
    new Set(validation.map((item) => item.ref)),
  );
  const primaryName = group?.name;

  const delivered = finalResults(
    details.data?.resultReferences ?? [],
    all,
  ).candidates;
  const candidateByRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );

  const ordered = [...candidates].sort((a, b) => {
    if (a.parentRef === null && b.parentRef !== null) return -1;
    if (b.parentRef === null && a.parentRef !== null) return 1;
    return labels
      .candidate(a.ref)
      .localeCompare(labels.candidate(b.ref), undefined, { numeric: true });
  });
  const matching = ordered.filter((item) =>
    `${labels.candidate(item.ref)} ${item.ref}`
      .toLowerCase()
      .includes((search ?? '').toLowerCase()),
  );
  const pageOffset = (offset ?? 0) < matching.length ? (offset ?? 0) : 0;
  const visible = matching.slice(pageOffset, pageOffset + 50);
  const name = (ref: string): string =>
    labels.candidate(ref).replace(/Round /g, 'R');
  return (
    <section className="candidate-version-list" aria-label="Candidate versions">
      <label className="browser-search">
        Search versions
        <input
          type="search"
          value={search ?? ''}
          placeholder="Version or candidate ID"
          onChange={(event) =>
            replaceRouteSelection({ search: event.target.value, offset: 0 })
          }
        />
      </label>
      <Feedback {...details} />
      {details.data ? (
        <>
          <Table className="candidate-version-table">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>From</TableHead>
                <TableHead title={group ? metricLabel(group) : undefined}>
                  {primaryName === 'outputThroughput' ? 'Throughput' : 'Score'}
                </TableHead>
                <TableHead title="Change compared with parent">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => {
                const value = scores.get(item.ref)?.value;
                const parentValue = item.parentRef
                  ? scores.get(item.parentRef)?.value
                  : null;
                const delta =
                  group?.comparable && value != null && parentValue != null
                    ? value - parentValue
                    : null;
                return (
                  <TableRow
                    key={item.ref}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest('a, button') ||
                        window.getSelection()?.toString()
                      )
                        return;
                      event.currentTarget
                        .querySelector<HTMLAnchorElement>(
                          '.candidate-version-link',
                        )
                        ?.click();
                    }}
                    data-selected={item.ref === selected ? 'true' : undefined}
                  >
                    <TableCell>
                      <a
                        className="candidate-version-link"
                        href={route(id, 'candidates', item.ref, undefined, {
                          search,
                          offset: pageOffset,
                        })}
                        aria-current={
                          item.ref === selected ? 'true' : undefined
                        }
                      >
                        {name(item.ref)}
                        {delivered.includes(item.ref) ? (
                          <span className="candidate-final-label">Final</span>
                        ) : null}
                      </a>
                    </TableCell>
                    <TableCell>
                      {item.parentRef ? (
                        candidateByRef.has(item.parentRef) ? (
                          <a
                            className="text-link"
                            href={route(
                              id,
                              'candidates',
                              item.parentRef,
                              undefined,
                              { search, offset: pageOffset },
                            )}
                          >
                            {name(item.parentRef)}
                          </a>
                        ) : (
                          <span title={item.parentRef}>Unavailable</span>
                        )
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {value == null ? '—' : scoreLabel(value)}
                    </TableCell>
                    <TableCell>
                      {delta === null
                        ? '—'
                        : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${scoreLabel(Math.abs(delta))}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!matching.length ? (
            <p className="empty-state">No matching versions.</p>
          ) : null}
          <p className="muted">
            From: parent version · Δ: change from parent.
            {group ? ` Metric: ${metricLabel(group)}.` : ''}
          </p>
          <Pagination
            page={{
              items: visible,
              total: matching.length,
              nextOffset:
                pageOffset + 50 < matching.length ? pageOffset + 50 : null,
            }}
            offset={pageOffset}
            setOffset={(value) => replaceRouteSelection({ offset: value })}
          />
        </>
      ) : null}
    </section>
  );
}
