import { HarnessCandidates } from './harness-candidates';
import { useRoundLabels } from './round-labels';
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
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/candidates`,
    parseCandidates,
  );
  const location = useRoute();
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
          <Feedback {...result} />
          {result.data ? (
            candidates.length ? (
              <>
                {candidates.length > 1 ? (
                  labels.isHarness ? (
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
                  )
                ) : null}
                {current ? (
                  <section
                    className="candidate-detail-panel"
                    aria-labelledby="candidate-detail-title"
                  >
                    <div className="section-heading">
                      <h3 id="candidate-detail-title">
                        {labels.candidate(current.ref)}
                      </h3>
                    </div>
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
                          {parent ? (
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
                          {parent && !fullFiles ? (
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
              </>
            ) : (
              <p className="empty-state">No candidates recorded.</p>
            )
          ) : null}
        </CardContent>
      </Card>
      {result.data && (candidates.length > 150 || search) ? (
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
