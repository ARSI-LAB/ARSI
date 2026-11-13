import { QueryCache } from '../../api/query-cache';
import { subscribeRetry } from '../../api/connection-state';
import React, { useEffect, useState } from 'react';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { Feedback } from '../../components/observation-feedback';
import {
  changedLines,
  loadCandidateDiff,
  type CandidateDiff,
} from './candidate-diff';

const diffCache = new QueryCache<CandidateDiff>(8);

export function CandidateTextDiff({
  id,
  parent,
  current,
  prefix,
}: {
  id: string;
  parent: string;
  current: string;
  prefix?: string;
}): React.JSX.Element {
  const cacheKey = JSON.stringify([id, parent, current, prefix ?? '']);
  const [state, setState] = useState<{ data?: CandidateDiff; error: string }>({
    data: diffCache.peek(cacheKey),
    error: '',
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeRetry(() => setRevision((value) => value + 1)), []);
  const selected = useRoute().diffFile;
  const setSelected = (diffFile: string): void =>
    replaceRouteSelection({ diffFile });
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: diffCache.peek(cacheKey), error: '' });
    diffCache
      .read(
        cacheKey,
        (signal) =>
          loadCandidateDiff(id, parent, current, signal, prefix, revision > 0),
        controller.signal,
        60000,
        revision > 0,
      )
      .then(
        (data) => {
          if (!controller.signal.aborted) setState({ data, error: '' });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              error: error instanceof Error ? error.message : String(error),
            });
        },
      );
    return () => controller.abort();
  }, [id, parent, current, revision, prefix, cacheKey]);
  const currentFile = selected
    ? state.data?.changes.find((change) => change.path === selected)
    : state.data?.changes[0];
  const lines =
    currentFile && currentFile.kind !== 'unavailable'
      ? changedLines(currentFile.before, currentFile.after)
      : [];
  const comparableChanges =
    state.data?.changes.filter((change) => change.kind !== 'unavailable')
      .length ?? 0;
  const unavailable =
    state.data?.changes.filter((change) => change.kind === 'unavailable')
      .length ?? 0;
  return (
    <div className="candidate-file-content">
      <Feedback
        loading={!state.data && !state.error}
        error={state.error}
        refresh={() => setRevision((value) => value + 1)}
      />
      {state.data ? (
        <>
          <p className="muted">
            {comparableChanges} changed text{' '}
            {comparableChanges === 1 ? 'file' : 'files'} ·{' '}
            {state.data.unchanged} unchanged
            {unavailable ? ` · ${unavailable} not comparable` : ''}
          </p>
          {state.data.changes.length ? (
            <div className="diff-workspace">
              <nav className="diff-file-list" aria-label="Changed files">
                {state.data.changes.map((change) => (
                  <button
                    key={change.path}
                    className="diff-file-option"
                    data-kind={change.kind}
                    aria-pressed={change.path === currentFile?.path}
                    onClick={() => setSelected(change.path)}
                  >
                    <span className="diff-file-kind">{change.kind}</span>
                    <code>{change.path.slice(prefix?.length ?? 0)}</code>
                  </button>
                ))}
              </nav>
              <section className="section-stack" aria-label="File changes">
                {selected && !currentFile ? (
                  <p className="filter-note">
                    The selected file is not among this version's recorded
                    changes.{' '}
                    <button
                      className="quiet-button"
                      onClick={() =>
                        replaceRouteSelection({ diffFile: undefined })
                      }
                    >
                      Clear file selection
                    </button>
                  </p>
                ) : null}
                <h3 className="diff-file-heading">
                  {currentFile?.path.slice(prefix?.length ?? 0)}
                </h3>
                {currentFile?.reason ? (
                  <p className="filter-note">{currentFile.reason}</p>
                ) : currentFile ? (
                  <>
                    {lines.length > 400 ? (
                      <p className="filter-note">
                        Showing the first 400 comparison lines. Use the full
                        file view to read the saved previews.
                      </p>
                    ) : null}
                    <div
                      className="diff-code"
                      tabIndex={0}
                      role="region"
                      aria-label="Text diff"
                    >
                      {lines.slice(0, 400).map((line, index) => (
                        <div
                          className="diff-line"
                          data-kind={line.kind}
                          key={index}
                        >
                          <span>{line.before ?? ''}</span>
                          <span>{line.after ?? ''}</span>
                          <span className="diff-sign" aria-hidden="true">
                            {line.kind === 'removed'
                              ? '-'
                              : line.kind === 'added'
                                ? '+'
                                : ' '}
                          </span>
                          <code>{line.text || ' '}</code>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </section>
            </div>
          ) : (
            <p className="empty-state">
              No readable text changes from the previous version.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
