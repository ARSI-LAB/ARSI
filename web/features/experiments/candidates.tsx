import { HarnessCandidates } from './harness-candidates';
import { useCallRecords, useRoundLabels } from './round-labels';
import React from 'react';
import { parseCandidates } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { Feedback, Pagination } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { ArtifactBrowser } from './artifact-browser';
import { CandidateRelations } from './candidate-relations';
import { CandidateTextDiff } from './candidate-text-diff';
import { useAllObservations } from './use-observation';

export function Candidates({
  id,
  selected,
  artifact,
  file,
  directory,
}: {
  id: string;
  selected?: string;
  artifact?: string;
  file?: string;
  directory?: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const { labelsLoading, labelsError, refreshLabels, measurements } =
    useCallRecords();
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/candidates`,
    parseCandidates,
  );
  const location = useRoute();
  const detailPanel = React.useRef<HTMLElement>(null);
  const listPanel = React.useRef<HTMLDivElement>(null);
  const lastCell = React.useRef(location.candidateCell ?? selected);
  React.useEffect(() => {
    if (
      lastCell.current !== (location.candidateCell ?? selected) &&
      (location.candidateCell ?? selected) &&
      window.matchMedia('(max-width: 1199px)').matches
    ) {
      detailPanel.current?.scrollIntoView({ block: 'start' });
    }
    lastCell.current = location.candidateCell ?? selected;
  }, [location.candidateCell, selected]);
  const fullFiles =
    location.content === 'files' || (!!file && location.content !== 'changes');
  const search = location.search ?? '',
    offset = location.offset ?? 0;
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const candidates = result.data?.items ?? [];
  const current = selected
    ? candidates.find((item) => item.ref === selected)
    : (candidates.find((candidate) => candidate.parentRef === null) ??
      candidates[0]);
  const parent = current?.parentRef
    ? candidates.find((item) => item.ref === current.parentRef)
    : undefined;
  const ancestry: typeof candidates = [];
  const seen = new Set<string>();
  let ancestor = current;
  while (ancestor && !seen.has(ancestor.ref)) {
    seen.add(ancestor.ref);
    ancestry.unshift(ancestor);
    ancestor = candidates.find((item) => item.ref === ancestor?.parentRef);
  }
  const selectedCell = location.candidateCell?.endsWith(`:${current?.ref}`)
    ? location.candidateCell.split(':')
    : undefined;
  const baseRefs = new Set(
    (measurements.data?.items ?? [])
      .filter((item) => {
        const stage = labels.harness(item.ref);
        return stage?.round === selectedCell?.[0] && stage?.variant === 'Base';
      })
      .map((item) => item.candidateRef),
  );
  const matchesBase =
    !!current &&
    candidates.some(
      (item) =>
        baseRefs.has(item.ref) && item.artifactRef === current.artifactRef,
    );
  const versionDescription =
    selectedCell?.[1] === 'Base' || (!selectedCell && !parent)
      ? 'Original — the baseline candidate.'
      : matchesBase
        ? 'No change — contents match this round’s Base.'
        : parent
          ? `Compared with ${labels.candidate(parent.ref)}`
          : 'Original — the baseline candidate.';
  const matching = candidates.filter((item) =>
    `${labels.candidate(item.ref)} ${item.ref} ${item.parentRef ?? ''} ${item.artifactRef}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const pageOffset = offset < matching.length ? offset : 0;
  const visible = matching.slice(pageOffset, pageOffset + 50);
  const candidateLink = (ref?: string, artifactRef?: string): string =>
    route(id, 'candidates', ref, artifactRef, { search, offset: pageOffset });
  return (
    <div className="section-stack">
      <Card>
        <CardHeader>
          <div className="section-heading">
            <div>
              <h2>Candidates</h2>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Feedback {...result} loading={false} />
          <Feedback
            loading={false}
            error={labelsError}
            refresh={refreshLabels}
          />
          {result.loading || labelsLoading ? (
            <div
              className="candidate-loading"
              role="status"
              aria-label="Loading candidates and comparisons"
            >
              <span>Loading candidates and comparisons…</span>
              <div className="candidate-loading-panes" aria-hidden="true">
                <div>
                  {Array.from({ length: 6 }, (_, index) => (
                    <div className="candidate-loading-row" key={index} />
                  ))}
                </div>
                <div className="candidate-loading-detail" />
              </div>
            </div>
          ) : result.data && !labelsError ? (
            candidates.length ? (
              <div
                className={`candidate-split${labels.isHarness ? '' : ' candidate-split-compact'}`}
              >
                <div className="candidate-list-pane" ref={listPanel}>
                  {labels.isHarness ? (
                    <HarnessCandidates
                      id={id}
                      candidates={candidates}
                      selected={current?.ref}
                    />
                  ) : (
                    <CandidateRelations
                      id={id}
                      candidates={candidates}
                      selected={current?.ref}
                    />
                  )}
                </div>
                {current ? (
                  <section
                    ref={detailPanel}
                    className="candidate-detail-panel"
                    aria-labelledby="candidate-detail-title"
                  >
                    <div className="section-heading">
                      <h3 id="candidate-detail-title">
                        {location.candidateCell?.endsWith(`:${current.ref}`)
                          ? location.candidateCell
                              .split(':')
                              .slice(0, 2)
                              .join(' · ')
                          : labels.candidate(current.ref)}
                      </h3>
                    </div>
                    <button
                      className="quiet-button candidate-back"
                      onClick={() =>
                        listPanel.current?.scrollIntoView({ block: 'start' })
                      }
                    >
                      Back to candidates
                    </button>
                    {!labels.isHarness && ancestry.length > 1 ? (
                      <nav
                        className="candidate-ancestry"
                        aria-label="Version ancestry"
                      >
                        {ancestry.map((item, index) => (
                          <React.Fragment key={item.ref}>
                            {index > 0 ? (
                              <span aria-hidden="true">›</span>
                            ) : null}
                            <a
                              href={candidateLink(item.ref)}
                              aria-current={
                                item.ref === current.ref ? 'page' : undefined
                              }
                            >
                              {labels
                                .candidate(item.ref)
                                .replace(/Round /g, 'R')}
                            </a>
                          </React.Fragment>
                        ))}
                      </nav>
                    ) : null}
                    <p className="muted">{versionDescription}</p>
                    {result.data && current ? (
                      artifact && artifact !== current.artifactRef ? (
                        <p className="error-notice" role="status">
                          This artifact does not belong to the selected
                          candidate.
                          <a
                            className="text-link"
                            href={candidateLink(current.ref)}
                          >
                            {' '}
                            Show recorded candidate files
                          </a>
                        </p>
                      ) : (
                        <>
                          {current ? (
                            <div
                              className="actions"
                              role="group"
                              aria-label="Candidate content"
                            >
                              <a
                                className="quiet-button"
                                aria-current={!fullFiles ? 'page' : undefined}
                                href={route(
                                  id,
                                  'candidates',
                                  current.ref,
                                  undefined,
                                  {
                                    ...location,
                                    content: 'changes',
                                  },
                                )}
                              >
                                Changes
                              </a>
                              <a
                                className="quiet-button"
                                aria-current={fullFiles ? 'page' : undefined}
                                href={route(
                                  id,
                                  'candidates',
                                  current.ref,
                                  undefined,
                                  {
                                    ...location,
                                    content: 'files',
                                  },
                                )}
                              >
                                Full files
                              </a>
                            </div>
                          ) : null}
                          {!parent && !fullFiles ? (
                            <p className="empty-state">
                              Select Full files to inspect the original
                              contents.
                            </p>
                          ) : parent && !fullFiles ? (
                            <CandidateTextDiff
                              key={current.ref}
                              id={id}
                              parent={parent.artifactRef}
                              current={current.artifactRef}
                            />
                          ) : (
                            <ArtifactBrowser
                              key={current.artifactRef}
                              id={id}
                              candidate={current.ref}
                              artifact={current.artifactRef}
                              file={file}
                              directory={directory}
                              embedded
                            />
                          )}
                        </>
                      )
                    ) : null}
                  </section>
                ) : (
                  <p className="error-notice" role="status">
                    The linked candidate is not in the recorded candidates.{' '}
                    <a className="text-link" href={route(id, 'candidates')}>
                      Clear selection
                    </a>
                  </p>
                )}
              </div>
            ) : (
              <p className="empty-state">No candidates recorded.</p>
            )
          ) : null}
        </CardContent>
      </Card>
      {labels.isHarness &&
      result.data &&
      (candidates.length > 150 || search) ? (
        <div>
          <Card>
            <CardHeader>
              <h2>Candidate records</h2>
            </CardHeader>
            <CardContent>
              <label className="browser-search">
                Search candidates
                <input
                  type="search"
                  value={search}
                  onChange={(event) => {
                    replaceRouteSelection({
                      search: event.target.value,
                      offset: 0,
                    });
                  }}
                  placeholder="Candidate, parent, or artifact reference"
                />
              </label>
              {visible.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Candidate</TableHead>
                      <TableHead>Parent</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((item) => (
                      <TableRow
                        key={item.ref}
                        data-selected={item.ref === current?.ref}
                      >
                        <TableCell>
                          <a
                            className="text-link"
                            href={candidateLink(item.ref)}
                          >
                            {labels.candidate(item.ref)}
                          </a>
                        </TableCell>
                        <TableCell>
                          {item.parentRef
                            ? labels.candidate(item.parentRef)
                            : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="empty-state">
                  No matching candidates. Change the search to see more records.
                </p>
              )}
              <Pagination
                page={{
                  items: visible,
                  total: matching.length,
                  nextOffset:
                    pageOffset + 50 < matching.length ? pageOffset + 50 : null,
                }}
                offset={pageOffset}
                setOffset={setOffset}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
