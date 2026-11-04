import React, { useMemo, useState, useEffect, useRef } from 'react';
import { parseCallTrace } from '../../api/observation-client';
import { Feedback, Timestamp } from '../../components/observation-feedback';
import { useObservation } from './use-observation';
import { traceRows, eventText, type TraceRow } from './trace-model';
import { scoreLabel } from './record-identifiers';

type Filter = 'All' | 'Model' | 'Tools' | 'Errors';
export function TraceInspector({
  id,
  callId,
  finished,
}: {
  id: string;
  callId: string;
  finished: boolean;
}): React.JSX.Element | null {
  const [offset, setOffset] = useState(0);
  const result = useObservation(
    `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/trace?offset=${offset}&limit=100`,
    parseCallTrace,
    finished ? null : 4000,
    finished,
  );
  const [pages, setPages] = useState<
    Record<number, ReturnType<typeof parseCallTrace>>
  >({});
  useEffect(() => {
    if (result.data) setPages((old) => ({ ...old, [offset]: result.data! }));
  }, [result.data, offset]);
  const rows = useMemo(
    () => traceRows(Object.values(pages).flatMap((p) => p.items)),
    [pages],
  );
  const [filter, setFilter] = useState<Filter>('All');
  const [selection, setSelection] = useState<string | null>(null);
  const [tab, setTab] = useState('Overview');
  const [page, setPage] = useState(0);
  const [closed, setClosed] = useState(true);
  const visible = rows.filter(
    (r) =>
      filter === 'All' ||
      (filter === 'Model' && r.kind === 'model') ||
      (filter === 'Tools' && r.kind === 'tool') ||
      (filter === 'Errors' && r.status === 'Failed'),
  );
  const selected = visible.find((r) => r.id === selection) ?? visible[0];
  const start = page * 50 < visible.length ? page * 50 : 0;
  const windowRows = visible.slice(start, start + 50);
  const list = useRef<HTMLDivElement>(null);
  const choose = (row: TraceRow): void => {
    setSelection(row.id);
    setTab('Overview');
    setClosed(false);
  };
  if (result.error && !rows.length) return <Feedback {...result} />;
  if (!result.data && !rows.length) return <Feedback {...result} />;
  if (!rows.length && (result.data?.unavailable || result.data?.total === 0))
    return null;
  const tabs =
    selected?.kind === 'tool'
      ? ['Overview', 'Arguments', 'Result']
      : ['Overview', 'Content'];
  const activeTab = tabs.includes(tab) ? tab : 'Overview';
  const navigate = (delta: number): void => {
    const i = selected
      ? visible.findIndex((r) => r.id === selected.id) + delta
      : 0;
    const next = visible[i];
    if (next) {
      choose(next);
      setPage(Math.floor(i / 50));
    }
  };
  return (
    <section className="trace-inspector" aria-label="Agent trace">
      <div className="inspector-toolbar">
        <div className="inspector-filters" aria-label="Event filters">
          {(['All', 'Model', 'Tools', 'Errors'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setPage(0);
                setTab('Overview');
              }}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <Feedback {...result} loading={false} />
      {result.data?.incomplete ? (
        <p className="trace-notice">
          Partial trace · Some recorded content is unavailable.
        </p>
      ) : null}
      <div
        className={`inspector-body ${closed || !selected ? 'inspector-no-detail' : ''}`}
      >
        <div
          className="inspector-events"
          ref={list}
          aria-label="Recorded events"
        >
          {windowRows.map((row, i) => (
            <React.Fragment key={row.id}>
              {i === 0 || windowRows[i - 1]?.step !== row.step ? (
                <div className="inspector-step">
                  {row.step ? `Step ${row.step}` : 'Execution'}
                </div>
              ) : null}
              <button
                className="inspector-row"
                aria-pressed={selected?.id === row.id && !closed}
                onClick={() => choose(row)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const index =
                      visible.findIndex((r) => r.id === row.id) +
                      (e.key === 'ArrowDown' ? 1 : -1);
                    const next = visible[index];
                    if (next) {
                      choose(next);
                      setPage(Math.floor(index / 50));
                      requestAnimationFrame(() =>
                        list.current
                          ?.querySelector<HTMLButtonElement>(
                            `[data-event="${next.id}"]`,
                          )
                          ?.focus(),
                      );
                    }
                  }
                }}
                data-event={row.id}
                title={row.summary.slice(0, 300)}
              >
                <span className={`inspector-kind ${row.kind}`}>
                  {row.kind === 'model'
                    ? 'AI'
                    : row.kind === 'tool'
                      ? 'T'
                      : '·'}
                </span>
                <span className="inspector-row-text">
                  <strong>{row.title}</strong>
                  <span>{row.summary.replace(/\s+/g, ' ').slice(0, 180)}</span>
                </span>
                <span
                  className={row.status === 'Failed' ? 'error-text' : 'muted'}
                >
                  {row.status === 'Failed'
                    ? 'Failed'
                    : row.duration !== null
                      ? `${scoreLabel(row.duration)} s`
                      : ''}
                </span>
              </button>
            </React.Fragment>
          ))}
          {!visible.length ? (
            <p className="empty-state">No matching events.</p>
          ) : null}
        </div>
        {!closed && selected ? (
          <aside className="inspector-detail" aria-label="Event details">
            <header>
              <div>
                <strong>{selected.title}</strong>
                <small>
                  {selected.step ? `Step ${selected.step}` : 'Execution'}
                </small>
              </div>
              <button
                aria-label="Close event details"
                onClick={() => {
                  setClosed(true);
                  list.current
                    ?.querySelector<HTMLButtonElement>(
                      `[data-event="${selected.id}"]`,
                    )
                    ?.focus();
                }}
              >
                ×
              </button>
            </header>
            <div className="inspector-tabs" aria-label="Detail views">
              {tabs.map((t) => (
                <button
                  key={t}
                  aria-pressed={activeTab === t}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="inspector-detail-content">
              <EventContent
                row={selected}
                tab={activeTab}
                onNavigate={setTab}
              />
            </div>
            <footer>
              <button
                disabled={visible[0] === selected}
                onClick={() => navigate(-1)}
              >
                ← Previous
              </button>
              <button
                disabled={visible.at(-1) === selected}
                onClick={() => navigate(1)}
              >
                Next →
              </button>
            </footer>
          </aside>
        ) : null}
      </div>
      <div className="inspector-pagination">
        <span>
          {visible.length
            ? `${start + 1}–${Math.min(start + 50, visible.length)} of ${visible.length} loaded events`
            : '0 matching events'}
        </span>
        <div>
          {visible.length > 50 ? (
            <>
              <button
                disabled={start === 0}
                onClick={() => {
                  setPage(Math.max(0, page - 1));
                  const row = visible[Math.max(0, start - 50)];
                  if (row) choose(row);
                }}
              >
                Previous
              </button>
              <button
                disabled={start + 50 >= visible.length}
                onClick={() => {
                  setPage(page + 1);
                  const row = visible[start + 50];
                  if (row) choose(row);
                }}
              >
                Next
              </button>
            </>
          ) : null}
          {result.data?.nextOffset !== null &&
          result.data?.nextOffset !== undefined ? (
            <button
              onClick={() => setOffset(result.data!.nextOffset!)}
              disabled={result.loading}
            >
              Load more
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
function EventContent({
  row,
  tab,
  onNavigate,
}: {
  row: TraceRow;
  tab: string;
  onNavigate: (tab: string) => void;
}): React.JSX.Element {
  const body =
    eventText(row.result) ||
    (row.result !== undefined
      ? JSON.stringify(row.result, null, 2)
      : 'Result not loaded');
  return (
    <>
      {tab === 'Overview' ? (
        <dl className="facts">
          <dt>Status</dt>
          <dd className={row.status === 'Failed' ? 'error-text' : ''}>
            {row.status}
          </dd>
          {row.at ? (
            <>
              <dt>Recorded</dt>
              <dd>
                <Timestamp value={row.at} />
              </dd>
            </>
          ) : null}
          {row.duration !== null ? (
            <>
              <dt>Duration</dt>
              <dd>{scoreLabel(row.duration)} s</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {tab === 'Overview' ? (
        <div className="overview-previews">
          {(row.kind === 'tool'
            ? [
                {
                  title: 'Arguments',
                  text:
                    row.args === undefined
                      ? 'Arguments not loaded'
                      : JSON.stringify(row.args, null, 2),
                },
                { title: 'Result', text: body },
              ]
            : [{ title: 'Content', text: row.summary }]
          ).map(({ title, text }) => (
            <button
              key={title}
              className="overview-preview"
              aria-label={`View ${title.toLowerCase()}`}
              onClick={() => onNavigate(title)}
            >
              <strong>
                {title} <span aria-hidden="true">›</span>
              </strong>
              <span className="overview-preview-text">
                {text.replace(/\s+/g, ' ').slice(0, 240)}
                {text.replace(/\s+/g, ' ').length > 240 ? '…' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : row.kind === 'tool' ? (
        <>
          {tab === 'Arguments' ? (
            <>
              <h4>Arguments</h4>
              <pre>
                {row.args === undefined
                  ? 'Arguments not loaded'
                  : JSON.stringify(row.args, null, 2)}
              </pre>
            </>
          ) : null}
          {tab === 'Result' ? (
            <>
              <h4>Result</h4>
              <pre>{body}</pre>
            </>
          ) : null}
        </>
      ) : (
        <>
          {row.thinking ? (
            <>
              <h4>Thinking</h4>
              <p className="inspector-thinking">{row.thinking}</p>
            </>
          ) : null}
          {row.body ? (
            <>
              <h4>{row.kind === 'model' ? 'Response' : 'Content'}</h4>
              <p>{row.body}</p>
            </>
          ) : null}
          {!row.body && !row.thinking ? <p>{row.summary}</p> : null}
        </>
      )}
      {row.truncated ? <p className="muted">Event preview truncated.</p> : null}
    </>
  );
}
