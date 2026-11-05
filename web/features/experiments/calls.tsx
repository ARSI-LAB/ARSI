import { ViewBoundary } from '../../components/view-boundary';
import { TraceInspector } from './trace-inspector';
import { PluginCallSummary } from './plugin-call-summary';
import { callLabels, ownerCallId } from './call-labels';
import { useCallRecords, useRoundLabels } from './round-labels';
import { type HarnessStage } from './round-label-model';
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

function useCallStages(
  measurements: MeasurementSummary[],
): Map<string, HarnessStage> {
  const labels = useRoundLabels();
  const stages = new Map<string, HarnessStage>();
  const ambiguous = new Set<string>();
  for (const measurement of measurements) {
    const stage = labels.harness(measurement.ref);
    if (!stage) continue;
    const prior = stages.get(measurement.callId);
    if (
      prior &&
      (prior.round !== stage.round || prior.variant !== stage.variant)
    )
      ambiguous.add(measurement.callId);
    stages.set(measurement.callId, stage);
  }
  for (const id of ambiguous) stages.delete(id);
  return stages;
}

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
  const stages = useCallStages(measurements);
  const identity = current ? callLabels(current, calls, stages) : null;
  const related = measurements.filter((item) => item.callId === callId);
  return (
    <section className="call-detail" aria-label="Selected call details">
      <Feedback {...result} />
      {current ? (
        <>
          <div className="section-heading">
            <h3>
              {identity?.title}
              {identity?.round ? (
                <span className="call-round">{identity.round}</span>
              ) : null}
            </h3>
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
            {showPayload && result.data ? (
              <>
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
  const [roundFilter, setRoundFilter] = React.useState('');
  const [componentFilter, setComponentFilter] = React.useState<string[] | null>(
    null,
  );
  const offset = location.offset ?? 0,
    search = location.search ?? '',
    status = location.status ?? '';
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const { calls: result, measurements } = useCallRecords();
  const calls = React.useMemo(() => result.data?.items ?? [], [result.data]);
  const stages = useCallStages(measurements.data?.items ?? []);
  const byId = new Map(calls.map((item) => [item.callId, item]));
  const identities = new Map(
    calls.map((item) => [item.callId, callLabels(item, calls, stages, byId)]),
  );
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
        (item) => identities.get(item.callId)!.round ?? 'No round recorded',
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const components = [
    ...new Set(componentCalls.map((item) => item.pluginId)),
  ].sort();
  const selectedComponents =
    componentFilter ??
    components.filter((plugin) => !plugin.startsWith('application.'));
  const changeComponents = (value: string[] | null): void => {
    setComponentFilter(value);
    replaceRouteSelection({ offset: 0, call: undefined });
  };
  const filtered = componentCalls.filter(
    (item) =>
      (!status || item.status === status) &&
      (!roundFilter ||
        (identities.get(item.callId)!.round ?? 'No round recorded') ===
          roundFilter) &&
      selectedComponents.includes(item.pluginId) &&
      `${identities.get(item.callId)!.title} ${identities.get(item.callId)!.round ?? ''} ${item.path ?? ''} ${item.pluginId} ${item.bindingId} ${item.callId} ${item.error ?? ''}`
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
                <div className="component-filter">
                  <span id="component-filter-label">Component</span>
                  <details
                    className="component-multiselect"
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        event.currentTarget.open = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.currentTarget.open = false;
                        event.currentTarget.querySelector('summary')?.focus();
                      }
                    }}
                  >
                    <summary aria-labelledby="component-filter-label component-filter-value">
                      <span id="component-filter-value">
                        {selectedComponents.length === components.length
                          ? 'All components'
                          : selectedComponents.length === 0
                            ? 'No components'
                            : `${selectedComponents.length} selected`}
                      </span>
                      <svg
                        className="component-filter-chevron"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </summary>
                    <div
                      className="component-filter-menu"
                      role="group"
                      aria-label="Components"
                    >
                      <div className="component-filter-actions">
                        <button
                          type="button"
                          onClick={() => changeComponents(components)}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => changeComponents([])}
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() => changeComponents(null)}
                        >
                          Reset
                        </button>
                      </div>
                      {components.map((plugin) => (
                        <label key={plugin}>
                          <input
                            type="checkbox"
                            checked={selectedComponents.includes(plugin)}
                            onChange={(event) =>
                              changeComponents(
                                event.target.checked
                                  ? [...selectedComponents, plugin]
                                  : selectedComponents.filter(
                                      (value) => value !== plugin,
                                    ),
                              )
                            }
                          />
                          <span>{plugin}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
              </>
              <label className="call-search-filter">
                Search calls
                <input
                  className="call-search"
                  type="search"
                  value={search}
                  onChange={(event) => {
                    replaceRouteSelection({
                      search: event.target.value,
                      offset: 0,
                      call: undefined,
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
                      call: undefined,
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
              <div className="call-list-panel">
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
                        <div className="compact-call-heading">
                          <strong>{identities.get(item.callId)!.title}</strong>
                          {identities.get(item.callId)!.round ? (
                            <span className="call-round">
                              {identities.get(item.callId)!.round}
                            </span>
                          ) : null}
                          {item.status !== 'succeeded' ? (
                            <span
                              className="compact-call-status"
                              data-status={item.status}
                              title={item.status}
                              aria-label={item.status}
                            >
                              {item.status}
                            </span>
                          ) : null}
                        </div>
                        <small>
                          {item.pluginId.startsWith('application.')
                            ? `${(item.path?.startsWith('call-') ? null : item.path?.split('/').at(-1)) ?? item.bindingId} · `
                            : ''}
                          {identities.get(item.callId)!.plugins} ·{' '}
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
                  <ViewBoundary key={selected}>
                    <CallPayload
                      key={selected}
                      id={id}
                      callId={selected}
                      calls={calls}
                      measurements={measurements.data?.items ?? []}
                    />
                  </ViewBoundary>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
