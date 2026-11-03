import React from 'react';
import {
  parseCallDetail,
  parseCalls,
  parseMeasurements,
  type MeasurementSummary,
} from '../../api/observation-client';
import { candidateLabel, evaluationOrdinals } from './record-identifiers';
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
import { useAllObservations, useObservation } from './use-observation';

function CallPayload({
  id,
  callId,
  measurements,
}: {
  id: string;
  callId: string;
  measurements: MeasurementSummary[];
}): React.JSX.Element {
  const { search, status, offset } = useRoute();
  const result = useObservation(
    `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}`,
    parseCallDetail,
  );
  const related = measurements.filter((item) => item.callId === callId);
  const ordinals = evaluationOrdinals(measurements);
  return (
    <section className="call-detail" aria-label="Selected call details">
      <div className="section-heading">
        <h3>Call details</h3>
        <a
          className="text-link"
          title={callId}
          href={route(id, 'calls', undefined, undefined, {
            call: callId,
            search,
            status,
            offset,
          })}
        >
          Link to call
        </a>
      </div>
      <Feedback {...result} />
      {result.data ? (
        <>
          <div className="section-heading">
            <strong>{result.data.pluginId}</strong>
            <Status value={result.data.status} />
          </div>
          {result.data.error ? (
            <p className="error-notice">{result.data.error}</p>
          ) : null}
          <dl className="facts">
            <dt>Policy path</dt>
            <dd>{result.data.path ?? 'Not recorded'}</dd>
            {result.data.parentCallId && result.data.parentCallId !== 'root' ? (
              <>
                <dt>Parent call</dt>
                <dd>
                  <a
                    className="text-link"
                    href={route(id, 'calls', undefined, undefined, {
                      call: result.data.parentCallId,
                      search,
                      status,
                      offset,
                    })}
                  >
                    {result.data.parentCallId}
                  </a>
                </dd>
              </>
            ) : null}
            <dt>Started</dt>
            <dd>
              <Timestamp value={result.data.startedAt} />
            </dd>
            <dt>Finished</dt>
            <dd>
              <Timestamp value={result.data.finishedAt} />
            </dd>
          </dl>
          {related.length ? (
            <nav
              className="related-evaluations"
              aria-label="Related evaluations"
            >
              {related.map((item) => (
                <div className="actions" key={item.ref}>
                  <a
                    className="text-link"
                    href={route(id, 'candidates', item.candidateRef)}
                  >
                    Candidate {candidateLabel(item.candidateRef)} →
                  </a>
                  <a
                    className="text-link"
                    href={route(id, 'measurements', undefined, undefined, {
                      measurement: item.ref,
                    })}
                  >
                    Evaluation #{ordinals.get(item.ref)} →
                  </a>
                </div>
              ))}
            </nav>
          ) : null}
          <Preview label="Input" value={result.data.input} />
          <Preview label="Output" value={result.data.output} />
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
  const offset = location.offset ?? 0,
    search = location.search ?? '',
    status = location.status ?? '';
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const result = useAllObservations(
    `/${encodeURIComponent(id)}/calls`,
    parseCalls,
  );
  const measurements = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
  );
  const calls = result.data?.items ?? [];
  const statuses = [...new Set(calls.map((item) => item.status))];
  const filtered = calls.filter(
    (item) =>
      (!status || item.status === status) &&
      `${item.path ?? ''} ${item.pluginId} ${item.bindingId} ${item.callId} ${item.error ?? ''}`
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
            <p className="muted">
              {filtered.length} of {calls.length} recorded calls
            </p>
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
                          selected === item.callId ? 'true' : undefined
                        }
                        href={route(id, 'calls', undefined, undefined, {
                          call: item.callId,
                          search,
                          status,
                          offset: pageOffset,
                        })}
                      >
                        <div className="section-heading">
                          <span>{item.bindingId}</span>
                          <Status value={item.status} />
                        </div>
                        <strong>{item.path ?? item.pluginId}</strong>
                        <small>
                          {item.pluginId} ·{' '}
                          {seconds === null || seconds === undefined
                            ? 'Duration not recorded'
                            : `${seconds.toLocaleString()} s`}
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
                  {call && !visible.some((item) => item.callId === call) ? (
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
                    measurements={measurements.data?.items ?? []}
                  />
                </div>
              ) : (
                <p className="empty-state">
                  Select a call to inspect recorded details.
                </p>
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
