import { TraceInspector } from './trace-inspector';
import { PluginCallSummary } from './plugin-call-summary';
import { callLabels, ownerCallId } from './call-labels';
import { useCallRecords, useRoundLabels } from './round-labels';
import { roundLabel } from './round-label-model';
import React from 'react';
import {
  parseCallDetail,
  parseCallInstructions,
  type MeasurementSummary,
  type CallSummary,
} from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import {
  Feedback,
  Pagination,
  Preview,
  Status,
  Timestamp,
} from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { callDurations } from './charts/metric-data';
import { useObservation } from './use-observation';

function Instructions({
  id,
  callId,
  finished,
}: {
  id: string;
  callId: string;
  finished: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const result = useObservation(
    open
      ? `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/instructions`
      : null,
    parseCallInstructions,
    null,
    finished,
  );
  return (
    <details
      className="call-instructions"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Instructions</summary>
      {open ? (
        <>
          <Feedback {...result} />
          {result.data?.prompt ? (
            <>
              <p className="muted">
                Recorded prompt; not a full model request snapshot.
              </p>
              <pre>{result.data.prompt.text}</pre>
              {result.data.prompt.truncated ? (
                <p className="muted">Prompt preview truncated.</p>
              ) : null}
            </>
          ) : result.data ? (
            <p className="muted">No prompt recorded.</p>
          ) : null}
        </>
      ) : null}
    </details>
  );
}

function CallPayload({
  id,
  callId,
  measurements,
  calls,
}: {
  id: string;
  callId: string;
  measurements: MeasurementSummary[];
  calls: CallSummary[];
}): React.JSX.Element {
  const { search, status, offset } = useRoute();
  const [showPayload, setShowPayload] = React.useState(true);
  const summary = calls.find((item) => item.callId === callId);
  const finished = !!summary?.finishedAt;
  const children = calls.filter(
    (item) =>
      item.pluginId === 'agent.pi' && ownerCallId(item, calls) === callId,
  );
  const [agentId, setAgentId] = React.useState(children[0]?.callId ?? '');
  const agent =
    summary?.pluginId === 'agent.pi'
      ? summary
      : (children.find((item) => item.callId === agentId) ?? children[0]);
  const summaryPayload =
    !!summary && /^(selector|application)\./.test(summary.pluginId);
  const result = useObservation(
    showPayload || summaryPayload || !summary
      ? `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}`
      : null,
    parseCallDetail,
    finished ? null : 4000,
    finished,
  );
  const current = summary ?? result.data;
  const identity = current ? callLabels(current, calls) : null;
  const related = measurements.filter((item) => item.callId === callId);
  return (
    <section className="call-detail" aria-label="Selected call details">
      <Feedback {...result} />
      {current ? (
        <>
          <div className="section-heading">
            <h3>{identity?.title}</h3>
            <Status value={current.status} />
          </div>
          {current.error ? (
            <p className="error-notice">{current.error}</p>
          ) : null}
          <p className="muted">{identity?.plugins}</p>
          <details className="call-metadata">
            <summary>Call information</summary>
            <dl className="facts">
              <dt>Policy path</dt>
              <dd>{identity?.path ?? 'Not recorded'}</dd>
              {current.parentCallId && current.parentCallId !== 'root' ? (
                <>
                  <dt>Parent call</dt>
                  <dd>
                    <a
                      className="text-link"
                      href={route(id, 'calls', undefined, undefined, {
                        call: current.parentCallId,
                        search,
                        status,
                        offset,
                      })}
                    >
                      {identity?.parent ?? 'Parent call'}
                    </a>
                  </dd>
                </>
              ) : null}
              <dt>Started</dt>
              <dd>
                <Timestamp value={current.startedAt} />
              </dd>
              <dt>Finished</dt>
              <dd>
                <Timestamp value={current.finishedAt} />
              </dd>
            </dl>
          </details>
          <PluginCallSummary
            id={id}
            plugin={current.pluginId}
            detail={result.data}
            measurements={related}
          />
          {children.length > 1 ? (
            <div
              className="agent-selection"
              role="group"
              aria-label="Agent sessions"
            >
              {children.map((item) => {
                const isSubagent = calls.some(
                  (parent) =>
                    parent.callId === item.parentCallId &&
                    parent.pluginId.startsWith('agent.'),
                );
                const siblings = children.filter(
                  (child) =>
                    calls.some(
                      (parent) =>
                        parent.callId === child.parentCallId &&
                        parent.pluginId.startsWith('agent.'),
                    ) === isSubagent,
                );
                const label = isSubagent ? 'Sub-agent' : 'Main agent';
                return (
                  <button
                    key={item.callId}
                    className="quiet-button"
                    aria-pressed={agent?.callId === item.callId}
                    onClick={() => setAgentId(item.callId)}
                  >
                    {label}
                    {siblings.length > 1
                      ? ` ${siblings.indexOf(item) + 1}`
                      : ''}
                  </button>
                );
              })}
            </div>
          ) : null}
          {agent ? (
            <div className="embedded-agent" key={agent.callId}>
              {current.callId !== agent.callId ? (
                <div className="embedded-agent-status">
                  <span>{agent.pluginId}</span>
                  <Status value={agent.status} />
                </div>
              ) : null}
              <Instructions
                id={id}
                callId={agent.callId}
                finished={!!agent.finishedAt}
              />
              <TraceInspector
                id={id}
                callId={agent.callId}
                finished={!!agent.finishedAt}
              />
            </div>
          ) : null}
          <details
            className="call-instructions"
            open={showPayload}
            onToggle={(event) => setShowPayload(event.currentTarget.open)}
          >
            <summary>Input / Output</summary>
            {showPayload ? (
              <>
                <Feedback {...result} />
                <Preview label="Input" value={result.data?.input ?? null} />
                <Preview label="Output" value={result.data?.output ?? null} />
              </>
            ) : null}
          </details>
        </>
      ) : null}
    </section>
  );
}

export function Calls({
  id,
  call,
}: {
  id: string;
  call?: string;
}): React.JSX.Element {
  const location = useRoute();
  const labels = useRoundLabels();
  const [roundFilter, setRoundFilter] = React.useState('');
  const [componentFilter, setComponentFilter] = React.useState('');
  const offset = location.offset ?? 0,
    search = location.search ?? '',
    status = location.status ?? '';
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const { calls: result, measurements } = useCallRecords();
  const calls = result.data?.items ?? [];
  const statuses = [
    ...new Set([
      'running',
      'succeeded',
      'failed',
      'cancelled',
      ...calls.map((item) => item.status),
    ]),
  ];
  const componentCalls = calls.filter(
    (item) => ownerCallId(item, calls) === item.callId,
  );
  const rounds = [
    ...new Set(
      componentCalls.map(
        (item) => roundLabel(item.path) ?? 'No round recorded',
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const components = [
    ...new Set(componentCalls.map((item) => item.pluginId)),
  ].sort();
  const filtered = componentCalls.filter(
    (item) =>
      (!status || item.status === status) &&
      (!labels.isHarness ||
        !roundFilter ||
        (roundLabel(item.path) ?? 'No round recorded') === roundFilter) &&
      (!labels.isHarness ||
        !componentFilter ||
        item.pluginId === componentFilter) &&
      `${callLabels(item, calls).title} ${item.path ?? ''} ${item.pluginId} ${item.bindingId} ${item.callId} ${item.error ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const pageOffset = offset < filtered.length ? offset : 0;
  const visible = filtered.slice(pageOffset, pageOffset + 50);
  const selected = call ?? visible[0]?.callId;
  const durations = new Map(
    callDurations(calls).map((item) => [item.callId, item.seconds]),
  );
  return (
    <Card>
      <CardHeader>
        <div className="section-heading">
          <div>
            <h2>Call history</h2>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Feedback {...result} />
        {measurements.error ? <Feedback {...measurements} /> : null}
        {result.data ? (
          <>
            <div className="call-filters">
              {labels.isHarness ? (
                <>
                  <label>
                    Round
                    <select
                      value={roundFilter}
                      onChange={(event) => {
                        setRoundFilter(event.target.value);
                        replaceRouteSelection({ offset: 0, call: undefined });
                      }}
                    >
                      <option value="">All rounds</option>
                      {rounds.map((round) => (
                        <option key={round}>{round}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Component
                    <select
                      value={componentFilter}
                      onChange={(event) => {
                        setComponentFilter(event.target.value);
                        replaceRouteSelection({ offset: 0, call: undefined });
                      }}
                    >
                      <option value="">All components</option>
                      {components.map((plugin) => (
                        <option key={plugin}>{plugin}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              <label>
                Search calls
                <input
                  className="call-search"
                  type="search"
                  value={search}
                  onChange={(event) => {
                    replaceRouteSelection({
                      search: event.target.value,
                      offset: 0,
                    });
                  }}
                  placeholder="Step, plugin, binding, ID, or error"
                />
              </label>
              <label>
                Call status
                <select
                  value={status}
                  onChange={(event) => {
                    replaceRouteSelection({
                      status: event.target.value,
                      offset: 0,
                    });
                  }}
                >
                  <option value="">All statuses</option>
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted">{filtered.length} component calls</p>
            <div className="call-workspace">
              <div>
                <nav className="compact-calls" aria-label="Recorded calls">
                  {visible.map((item) => {
                    const seconds = durations.get(item.callId);
                    return (
                      <a
                        className="compact-call"
                        key={item.callId}
                        aria-current={
                          selected === item.callId ||
                          calls.some(
                            (child) =>
                              child.callId === selected &&
                              ownerCallId(child, calls) === item.callId,
                          )
                            ? 'true'
                            : undefined
                        }
                        href={route(id, 'calls', undefined, undefined, {
                          call: item.callId,
                          search,
                          status,
                          offset: pageOffset,
                        })}
                      >
                        <div className="section-heading">
                          <Status value={item.status} />
                        </div>
                        <strong>{callLabels(item, calls).title}</strong>
                        <small>
                          {item.pluginId.startsWith('application.')
                            ? `${(item.path?.startsWith('call-') ? null : item.path?.split('/').at(-1)) ?? item.bindingId} · `
                            : ''}
                          {callLabels(item, calls).plugins} ·{' '}
                          {seconds === null || seconds === undefined
                            ? 'Duration not recorded'
                            : `${seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} s`}
                        </small>
                        {item.error ? (
                          <span className="error-text">{item.error}</span>
                        ) : null}
                      </a>
                    );
                  })}
                </nav>
                {!visible.length ? (
                  <p className="empty-state">
                    {calls.length
                      ? 'No calls match these filters.'
                      : 'No calls recorded.'}
                  </p>
                ) : null}
                <Pagination
                  page={{
                    items: visible,
                    total: filtered.length,
                    nextOffset:
                      pageOffset + 50 < filtered.length
                        ? pageOffset + 50
                        : null,
                  }}
                  offset={pageOffset}
                  setOffset={setOffset}
                />
              </div>
              {selected ? (
                <div>
                  {call &&
                  !visible.some(
                    (item) =>
                      item.callId === call ||
                      calls.some(
                        (child) =>
                          child.callId === call &&
                          ownerCallId(child, calls) === item.callId,
                      ),
                  ) ? (
                    <p className="filter-note">
                      The linked call is outside the current list or filters.{' '}
                      <a
                        className="text-link"
                        href={route(id, 'calls', undefined, undefined, {
                          search,
                          status,
                          offset: pageOffset,
                        })}
                      >
                        Clear selection
                      </a>
                    </p>
                  ) : null}
                  <CallPayload
                    key={selected}
                    id={id}
                    callId={selected}
                    calls={calls}
                    measurements={measurements.data?.items ?? []}
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
