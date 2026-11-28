import { useLoadBoundary } from '../../hooks/use-load-boundary';
import React, { useMemo, useState, useRef } from 'react';
import type { JsonValue } from '../../../src/contracts/json.js';
import { readAgentCollaboration } from '../../../src/shared/observation/agent-collaboration.js';
import {
  parseCallTrace,
  parseAgentPayload,
} from '../../api/observation-client';
import { Feedback, Timestamp } from '../../components/observation-feedback';
import { useObservation } from './use-observation';
import {
  traceRows,
  traceAgents,
  traceMessageLabel,
  eventText,
  type TraceRow,
} from './trace-model';
import { scoreLabel } from './record-identifiers';
import { TraceInputs } from './trace-inputs';
import { TraceResults } from './trace-results';

type Filter = 'Activity' | 'Model' | 'Tools' | 'Errors' | 'All events';
const traceBatchSize = 300;
const rowsPerPage = 100;
export function TraceInspector({
  id,
  callId,
  finished,
}: {
  id: string;
  callId: string;
  finished: boolean;
}): React.JSX.Element | null {
  const callPath = `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}`;
  const [offset, setOffset] = useState(0);
  const result = useObservation(
    `${callPath}/trace?offset=${offset}&limit=${traceBatchSize}`,
    parseCallTrace,
    finished ? null : 4000,
    finished,
  );
  const [pages, setPages] = useState<
    Record<number, ReturnType<typeof parseCallTrace>>
  >({});
  if (result.data && pages[offset] !== result.data)
    setPages({ ...pages, [offset]: result.data });
  const [payloads, setPayloads] = useState<Record<string, JsonValue>>({});
  const events = useMemo(
    () =>
      Object.values(pages)
        .flatMap((p) => p.items)
        .map((event) => {
          if (!event.payloadRef || !payloads[event.payloadRef]) return event;
          return { ...event, event: payloads[event.payloadRef] };
        }),
    [pages, payloads],
  );
  const rows = useMemo(() => traceRows(events), [events]);
  const trace = pages[offset] ?? Object.values(pages).at(-1) ?? result.data;
  const moreEvents = trace?.nextOffset != null;
  const [run, setRun] = useState('main');
  const agents = useMemo(() => traceAgents(events), [events]);
  const agentOptions = Array.from(agents, ([id, agent]) => {
    const parent =
      agent.parent && agent.parent !== 'main'
        ? agents.get(agent.parent)
        : undefined;
    return {
      id,
      label: parent ? `${parent.label} › ${agent.label}` : agent.label,
    };
  });
  const agentEvents = events.filter((event) => event.runId === run);
  const nativeFinishObserved = agentEvents.some(
    (event) => event.type === 'run.finished',
  );
  const [filter, setFilter] = useState<Filter>('Activity');
  const [selection, setSelection] = useState<string | null>(null);
  const [parentEvent, setParentEvent] = useState<number | null>(null);
  const [parentEventUnavailable, setParentEventUnavailable] = useState(false);
  const [tab, setTab] = useState('Overview');
  const [page, setPage] = useState(0);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const visible = rows.filter(
    (r) =>
      r.runId === run &&
      (filter === 'All events' ||
        (filter === 'Activity' &&
          (r.kind !== 'event' || r.childRunId !== undefined)) ||
        (filter === 'Model' && r.kind === 'model') ||
        (filter === 'Tools' && r.kind === 'tool') ||
        (filter === 'Errors' && r.status === 'Failed')),
  );
  const selected = visible.find((r) => r.id === selection) ?? visible[0];
  const runFinished = finished || nativeFinishObserved;
  const selectedLabel =
    selected && traceMessageLabel(selected, moreEvents, runFinished);
  const linkedRun = selected?.childRunId;
  const showEvent = detailOpen && !!selected;
  const payloadRef = showEvent
    ? selected?.payloadRefs?.find((ref) => !Object.hasOwn(payloads, ref))
    : null;
  const payload = useObservation(
    payloadRef && !payloads[payloadRef]
      ? `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/agent/payloads/${encodeURIComponent(payloadRef)}`
      : null,
    parseAgentPayload,
    null,
  );
  if (
    payloadRef &&
    payload.data !== undefined &&
    !Object.hasOwn(payloads, payloadRef)
  )
    setPayloads({ ...payloads, [payloadRef]: payload.data });
  const start = page * rowsPerPage < visible.length ? page * rowsPerPage : 0;
  const end = Math.min(start + rowsPerPage, visible.length);
  const windowRows = visible.slice(start, end);
  const list = useRef<HTMLDivElement>(null);
  const [focusEvent, setFocusEvent] = useState<number | null>(null);
  const agentSelector = useRef<HTMLDivElement>(null);
  const parentEventIndex =
    parentEvent === null
      ? -1
      : visible.findIndex((row) => row.id === String(parentEvent));
  const loadedPage = pages[offset] ?? result.data;
  const nextOffset = loadedPage?.nextOffset;
  const watchForMore = moreEvents && end === visible.length;
  // A sparse filter can leave the sentinel visible without appending rows.
  // Reobserve when the visible page grows or the selected filter or agent changes.
  const loadBoundary = useLoadBoundary(
    list,
    JSON.stringify([run, filter, end]),
    () => {
      if (nextOffset != null && !result.error) setOffset(nextOffset);
    },
  );
  if (parentEvent !== null) {
    if (parentEventIndex >= 0) {
      setSelection(String(parentEvent));
      setTab('Overview');
      setDetailOpen(true);
      setPage(Math.floor(parentEventIndex / rowsPerPage));
      setParentEvent(null);
      setFocusEvent(parentEvent);
    } else if (nextOffset != null && nextOffset !== offset) {
      setOffset(nextOffset);
    } else if (loadedPage || result.error) {
      setParentEvent(null);
      setParentEventUnavailable(true);
    }
  }
  const choose = (row: TraceRow): void => {
    setParentEvent(null);
    setParentEventUnavailable(false);
    setSelection(row.id);
    setTab('Overview');
    setDetailOpen(true);
  };
  const chooseAgent = (runId: string): void => {
    setParentEvent(null);
    setParentEventUnavailable(false);
    setRun(runId);
    setPage(0);
    setSelection(null);
    setDetailOpen(false);
  };
  if (result.error && !rows.length) return <Feedback {...result} />;
  if (!result.data && !rows.length) return <Feedback {...result} />;
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
      setPage(Math.floor(i / rowsPerPage));
    }
  };
  return (
    <section className="trace-inspector" aria-label="Agent trace">
      <div className="inspector-toolbar" ref={agentSelector}>
        {agentOptions.length <= 4 ? (
          <div className="inspector-agents" role="group" aria-label="Agents">
            {agentOptions.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={run === id}
                onClick={() => chooseAgent(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <label className="inspector-agent-select">
            Agent
            <select
              value={run}
              onChange={(event) => chooseAgent(event.target.value)}
            >
              {agentOptions.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div
          className="inspector-filters"
          role="group"
          aria-label="Event filters"
        >
          {(
            ['Activity', 'Model', 'Tools', 'Errors', 'All events'] as const
          ).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setParentEvent(null);
                setParentEventUnavailable(false);
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
      <details
        className="inspector-inputs"
        open={inputsOpen}
        onToggle={(event) => setInputsOpen(event.currentTarget.open)}
      >
        <summary>Inputs</summary>
        {inputsOpen ? (
          <div className="inspector-input-view">
            <TraceInputs
              key={run}
              id={id}
              callId={callId}
              runId={run}
              finished={finished}
              onViewParentEvent={({ parentRunId, sequence }) => {
                chooseAgent(parentRunId);
                setFilter('Activity');
                setInputsOpen(false);
                setParentEvent(sequence);
              }}
            />
          </div>
        ) : null}
      </details>
      {trace && !trace.unavailable ? (
        <TraceResults
          key={run}
          callPath={callPath}
          sequence={
            trace.finalResponses.find((item) => item.runId === run)?.sequence
          }
          finished={runFinished}
          main={run === 'main'}
        />
      ) : null}
      {parentEvent !== null || parentEventUnavailable ? (
        <p className="trace-notice" role="status">
          {parentEventUnavailable
            ? 'Parent event could not be loaded.'
            : 'Locating parent event…'}
        </p>
      ) : null}
      <Feedback {...result} loading={false} />
      {trace?.unavailable ? (
        <p className="trace-notice">{trace.unavailable}</p>
      ) : null}
      {trace?.recording === 'interrupted' ? (
        <p className="trace-notice">
          Recording was interrupted or could not be verified.
        </p>
      ) : trace?.incomplete ? (
        <p className="trace-notice">
          The trace contains an observation gap. See All events for details.
        </p>
      ) : null}
      {finished &&
      !moreEvents &&
      !nativeFinishObserved &&
      agentEvents.length > 0 ? (
        <p className="trace-notice">
          No run outcome was observed for this Agent.
        </p>
      ) : null}
      <div
        className={`inspector-body ${showEvent ? '' : 'inspector-no-detail'}`}
      >
        <div
          className="inspector-events"
          ref={list}
          aria-label="Recorded events"
        >
          {windowRows.map((row, i) => {
            const label = traceMessageLabel(row, moreEvents, runFinished);
            return (
              <React.Fragment key={row.id}>
                {i === 0 || windowRows[i - 1]?.step !== row.step ? (
                  <div className="inspector-step">
                    {row.step ? `Step ${row.step}` : 'Execution'}
                  </div>
                ) : null}
                <button
                  ref={
                    focusEvent !== null && String(focusEvent) === row.id
                      ? (node) => {
                          if (node) {
                            node.focus();
                            setFocusEvent(null);
                          }
                        }
                      : undefined
                  }
                  className="inspector-row"
                  aria-pressed={selected?.id === row.id && showEvent}
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
                        setPage(Math.floor(index / rowsPerPage));
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
                    <strong>{label.title}</strong>
                    <span>
                      {row.childRunId
                        ? (agents.get(row.childRunId)?.label ?? row.summary)
                        : row.title === 'run.started' ||
                            row.title === 'run.linked'
                          ? agents.get(agents.get(row.runId)?.parent ?? '')
                              ?.label
                            ? `Parent: ${agents.get(agents.get(row.runId)?.parent ?? '')?.label}`
                            : agents.get(row.runId)?.label
                          : row.summary.replace(/\s+/g, ' ').slice(0, 180)}
                    </span>
                  </span>
                  <span
                    className={row.status === 'Failed' ? 'error-text' : 'muted'}
                  >
                    {row.status === 'Failed'
                      ? 'Failed'
                      : row.duration !== null
                        ? `${scoreLabel(row.duration)} s`
                        : row.status === 'Streaming'
                          ? label.status
                          : row.status === 'Running'
                            ? moreEvents
                              ? 'More events not loaded'
                              : finished
                                ? 'Completion not observed'
                                : row.status
                            : ''}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
          {!visible.length ? (
            <p className="empty-state">No matching events.</p>
          ) : null}
          {watchForMore ? (
            <div
              className="trace-load-boundary"
              ref={loadBoundary}
              aria-hidden="true"
            />
          ) : null}
        </div>
        {showEvent && selected && selectedLabel ? (
          <aside className="inspector-detail" aria-label="Event details">
            {payloadRef && !payloads[payloadRef] ? (
              <Feedback {...payload} />
            ) : null}
            <header>
              <div>
                <strong>{selectedLabel.title}</strong>
                <small>
                  {selected.step ? `Step ${selected.step}` : 'Execution'}
                </small>
              </div>
              <button
                aria-label="Close event details"
                onClick={() => {
                  setDetailOpen(false);
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
              {linkedRun && agents.has(linkedRun) ? (
                <button
                  className="quiet-button"
                  onClick={() => {
                    chooseAgent(linkedRun);
                    requestAnimationFrame(() =>
                      agentSelector.current
                        ?.querySelector<HTMLElement>(
                          '.inspector-agents [aria-pressed="true"], .inspector-agent-select select',
                        )
                        ?.focus(),
                    );
                  }}
                >
                  View {agents.get(linkedRun)?.label}
                </button>
              ) : null}
              <EventContent
                row={
                  selectedLabel === selected
                    ? selected
                    : { ...selected, ...selectedLabel }
                }
                tab={activeTab}
                onNavigate={setTab}
                agentLabel={(runId) => agents.get(runId)?.label ?? runId}
                payloadPending={!!payloadRef && !payload.error}
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
            ? `${start + 1}–${end} of ${visible.length} rows`
            : '0 matching rows'}
          {trace && !trace.unavailable
            ? ` · Loaded ${events.length} of ${trace.total} call events`
            : ''}
        </span>
        <div>
          {visible.length > rowsPerPage ? (
            <>
              <button
                disabled={start === 0}
                onClick={() => {
                  setPage(Math.max(0, page - 1));
                  const row = visible[Math.max(0, start - rowsPerPage)];
                  if (row) choose(row);
                }}
              >
                Previous
              </button>
              <button
                disabled={end >= visible.length}
                onClick={() => {
                  setPage(page + 1);
                  const row = visible[end];
                  if (row) choose(row);
                }}
              >
                Next
              </button>
            </>
          ) : null}
          {moreEvents ? (
            <button
              onClick={() => {
                if (nextOffset != null) setOffset(nextOffset);
              }}
              disabled={nextOffset == null || result.loading}
            >
              {result.loading ? 'Loading more…' : 'Load more'}
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
  agentLabel,
  payloadPending,
}: {
  row: TraceRow;
  tab: string;
  onNavigate: (tab: string) => void;
  agentLabel: (runId: string) => string;
  payloadPending: boolean;
}): React.JSX.Element {
  const request = readAgentCollaboration(row.args);
  const outcome = readAgentCollaboration(row.result);
  const collaboration = outcome ?? request;
  const spawn =
    collaboration?.tool === 'spawnAgent' || row.title === 'Subagent started';
  const message = row.delegationMessage ?? request?.message ?? outcome?.message;
  const targets = outcome?.targets.length
    ? outcome.targets
    : (request?.targets ?? []);
  const states = outcome?.states.length
    ? outcome.states
    : (request?.states ?? []);
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
          {row.sessionId ? (
            <>
              <dt>Backend session</dt>
              <dd>{row.sessionId}</dd>
            </>
          ) : null}
          {row.turnId ? (
            <>
              <dt>Backend turn</dt>
              <dd>{row.turnId}</dd>
            </>
          ) : null}
          {row.duration !== null ? (
            <>
              <dt>Duration</dt>
              <dd>{scoreLabel(row.duration)} s</dd>
            </>
          ) : null}
          {spawn || collaboration?.tool === 'wait' ? (
            <>
              <dt>{spawn ? 'Delegated to' : 'Wait targets'}</dt>
              <dd>
                {row.childRunId
                  ? agentLabel(row.childRunId)
                  : targets.map(agentLabel).join(', ') ||
                    (payloadPending ? 'Loading…' : 'Not reported')}
              </dd>
            </>
          ) : null}
          {collaboration?.tool === 'wait' ? (
            <>
              <dt>Reported states</dt>
              <dd>
                {states.length ? (
                  <ul className="trace-reported-states">
                    {states.map(({ runId, status }) => (
                      <li key={runId}>
                        {agentLabel(runId)} · {status}
                      </li>
                    ))}
                  </ul>
                ) : payloadPending ? (
                  'Loading…'
                ) : (
                  'Not reported'
                )}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {tab === 'Overview' && spawn ? (
        <>
          <h4>Delegation message</h4>
          {message ? (
            <pre tabIndex={0}>{message}</pre>
          ) : (
            <p className="muted">
              {payloadPending ? 'Loading…' : 'Delegation message unavailable.'}
            </p>
          )}
        </>
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
              <h4>{row.kind === 'model' ? row.title : 'Content'}</h4>
              <p>{row.body}</p>
            </>
          ) : null}
          {!row.body && !row.thinking ? <p>{row.summary}</p> : null}
        </>
      )}
    </>
  );
}
