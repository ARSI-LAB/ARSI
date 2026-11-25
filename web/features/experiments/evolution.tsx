import React, { useEffect, useRef, useState } from 'react';
import {
  parseEvolution,
  parseApplication,
  applySnapshot,
  type EvolutionRecord,
} from '../../api/evolution-client';
import { parseArtifact } from '../../api/observation-client';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { route } from '../../app/routing';
import { Feedback, Timestamp } from '../../components/observation-feedback';
import { Card } from '../../components/ui/card';
import { useObservation, useAllObservations } from './use-observation';
import { CandidateTextDiff } from './candidate-text-diff';
import { parseArtifactFiles } from './file-browser-model';
import { roundLabel } from './round-label-model';

function bindingLabel(record: EvolutionRecord): string {
  if (record.binding) return record.binding;
  return (
    record.kind === 'initial' ? record.bindings : record.changedBindings
  ).join(', ');
}

function title(record: EvolutionRecord): string {
  if (record.binding === 'memory') {
    if (record.kind === 'initial') return 'Initial memory';
    return record.kind === 'attempt' ? 'Memory attempt' : 'Memory update';
  }
  return record.kind === 'initial'
    ? 'Initial version'
    : `Revision ${record.depth}`;
}

function Snapshot({
  id,
  artifact,
  prefix,
}: {
  id: string;
  artifact: string;
  prefix: string;
}): React.JSX.Element {
  const selection = useRoute();
  const base = `/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact)}`;
  const index = useAllObservations(base, parseArtifactFiles, null);
  const files =
    index.data?.items.filter((file) => file.path.startsWith(prefix)) ?? [];
  const selected =
    files.find((file) => file.path === selection.file) ?? files[0];
  const content = useObservation(
    selected ? `${base}?${new URLSearchParams({ path: selected.path })}` : null,
    parseArtifact,
    null,
  );
  return (
    <div className="section-stack">
      <Feedback {...index} />
      {files.length ? (
        <label className="evolution-field">
          File
          <select
            value={selected?.path}
            onChange={(event) =>
              replaceRouteSelection({ file: event.target.value })
            }
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path.slice(prefix.length)}
              </option>
            ))}
          </select>
        </label>
      ) : index.data ? (
        <p className="empty-state">No files recorded for this resource.</p>
      ) : null}
      <Feedback {...content} />
      {content.data?.unavailable ? (
        <p className="filter-note">{content.data.unavailable}</p>
      ) : content.data?.content ? (
        <>
          {content.data.content.truncated ? (
            <p className="filter-note">File preview is truncated.</p>
          ) : null}
          <pre tabIndex={0} aria-label="File contents">
            {content.data.content.text}
          </pre>
        </>
      ) : null}
    </div>
  );
}

function ApplySnapshot({
  id,
  revision,
  collection,
  label,
}: {
  id: string;
  revision: string;
  collection: 'memories' | 'revisions';
  label: string;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState('');
  const [previewTo, setPreviewTo] = useState('');
  const [inspection, setInspection] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [attempted, setAttempted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = new URLSearchParams({ inspection: String(inspection) });
  if (previewTo) query.set('targetDir', previewTo);
  const preview = useObservation(
    open
      ? `/${encodeURIComponent(id)}/${collection}/${encodeURIComponent(revision)}/application?${query}`
      : null,
    parseApplication,
    null,
    false,
    { cache: false },
  );
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = (): void => {
    if (!pending) {
      setOpen(false);
      trigger.current?.focus();
    }
  };
  const apply = async (): Promise<void> => {
    setPending(true);
    setError('');
    setAttempted(true);
    try {
      const status = await applySnapshot(id, collection, revision, previewTo);
      if (mounted.current) {
        setResult(
          status === 'applied'
            ? 'Destination files updated.'
            : 'No destination files needed updating.',
        );
        setOpen(false);
        trigger.current?.focus();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          `${failure instanceof Error ? failure.message : String(failure)} Inspect a fresh preview before applying again; some changes may already have completed.`,
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <div className="evolution-apply">
      <div className="section-heading">
        <p className="muted">Use this snapshot in future experiments.</p>
        <button
          ref={trigger}
          className="quiet-button evolution-primary"
          onClick={() => {
            setInspection((value) => value + 1);
            setAcknowledged(false);
            setAttempted(false);
            setError('');
            setOpen(true);
          }}
        >
          Preview application
        </button>
      </div>
      {result ? (
        <p role="status" className="evolution-success">
          {result}
        </p>
      ) : null}
      <dialog
        ref={dialog}
        className="evolution-dialog"
        aria-labelledby="evolution-apply-title"
        aria-describedby="evolution-apply-description"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <div className="section-heading">
          <h2 id="evolution-apply-title">Preview snapshot application</h2>
          <button
            className="quiet-button"
            disabled={pending}
            onClick={close}
            aria-label="Close local changes preview"
          >
            ×
          </button>
        </div>
        <p id="evolution-apply-description" className="muted">
          Selected snapshot: {label}.
        </p>
        <form
          className="actions"
          onSubmit={(event) => {
            event.preventDefault();
            setAcknowledged(false);
            setAttempted(false);
            setError('');
            setPreviewTo(destination.trim());
            setInspection((value) => value + 1);
          }}
        >
          <label className="evolution-field">
            Export directory (optional)
            <input
              value={destination}
              placeholder="Recorded source paths"
              disabled={pending}
              onChange={(event) => {
                setDestination(event.target.value);
                setAcknowledged(false);
              }}
            />
          </label>
          <button type="submit" className="quiet-button" disabled={pending}>
            Preview destination
          </button>
        </form>
        <Feedback {...preview} />
        {preview.data && !preview.error && previewTo === destination.trim() ? (
          <>
            {!preview.data.applicationAllowed ? (
              <section
                className="evolution-blocked"
                aria-label="Application unavailable"
              >
                <h3>Application unavailable</h3>
                {preview.data.restrictions.map((restriction) => {
                  const match =
                    /^Active or unresolved experiments: (.+)\. Retry after completion or recovery\.$/.exec(
                      restriction,
                    );
                  const blockers = match?.[1]?.split(', ');
                  return blockers &&
                    blockers.every((value) =>
                      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
                    ) ? (
                    <div key={restriction}>
                      <p>
                        These experiments are recorded as active or unresolved.
                        Complete or recover them, then check again.
                      </p>
                      <ul>
                        {blockers.map((experiment) => (
                          <li key={experiment}>
                            <a className="text-link" href={route(experiment)}>
                              {experiment}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p key={restriction}>{restriction}</p>
                  );
                })}
                <p className="muted">No files have been changed.</p>
              </section>
            ) : preview.data.changes.length ? (
              <div className="evolution-apply-summary">
                <h3>Files to update</h3>
                <p className="muted">
                  Local edits in these paths will be replaced by the saved
                  snapshot. Removed entries will be deleted.
                </p>
              </div>
            ) : null}
            {preview.data.destinations.map((path) => (
              <p key={path}>
                Destination <code>{path}</code>
              </p>
            ))}
            <ul className="evolution-plan">
              {preview.data.changes.map((change, index) => (
                <li key={index}>
                  <span className="status-badge">{change.action}</span>
                  <code>{change.path}</code>
                  {change.kind === 'directory' ? (
                    <span className="muted">Directory</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {preview.data.applicationAllowed && !preview.data.changes.length ? (
              <p>
                {preview.data.destinations.length
                  ? 'Destination files already match this version.'
                  : 'This revision has no changed resource roots to apply.'}
              </p>
            ) : null}
            {preview.data.applicationAllowed && preview.data.changes.length ? (
              <label className="evolution-ack">
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I have reviewed the destination files and want to apply these
                changes.
              </label>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="error-notice">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button className="quiet-button" disabled={pending} onClick={close}>
            {error ||
            !preview.data?.applicationAllowed ||
            !preview.data.changes.length
              ? 'Close'
              : 'Cancel'}
          </button>
          {preview.data &&
          !preview.data.applicationAllowed &&
          !preview.error ? (
            <button
              className="quiet-button"
              onClick={() => {
                setAcknowledged(false);
                setInspection((value) => value + 1);
              }}
            >
              Check again
            </button>
          ) : null}
          {preview.data?.applicationAllowed && preview.data.changes.length ? (
            <button
              className="quiet-button evolution-primary"
              disabled={
                pending ||
                attempted ||
                !acknowledged ||
                !!preview.error ||
                previewTo !== destination.trim()
              }
              onClick={() => void apply()}
            >
              {pending ? 'Applying…' : 'Apply to destination'}
            </button>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}

function Detail({
  id,
  record,
  memory,
}: {
  id: string;
  record: EvolutionRecord;
  memory: boolean;
}): React.JSX.Element {
  const selection = useRoute();
  const parent = record.parentArtifactRef;
  const full = !parent || selection.content === 'full';
  const prefix = memory
    ? ''
    : record.binding
      ? `bindings/${record.binding}/resources/`
      : 'resources/';
  return (
    <Card>
      <div className="ui-card-header">
        <div className="section-heading">
          <h2>{title(record)}</h2>
          <span
            className="status-badge"
            data-status={memory ? record.status : undefined}
          >
            {memory
              ? record.status
              : record.kind === 'initial'
                ? 'Initial'
                : 'Generated'}
          </span>
        </div>
        <p className="muted">
          {bindingLabel(record)}
          {record.kind !== 'initial' && roundLabel(record.path)
            ? ` · ${memory ? '' : 'Triggered after '}${roundLabel(record.path)}`
            : null}
          {record.startedAt ? (
            <>
              {' '}
              · <Timestamp value={record.startedAt} />
            </>
          ) : null}
        </p>
      </div>
      <div className="ui-card-content section-stack">
        {record.reason ? (
          <div className="evolution-reason">
            <h3>{memory ? 'What was learned' : 'Why this changed'}</h3>
            <p>{record.reason}</p>
          </div>
        ) : null}
        {record.resourceRef ? (
          <>
            <div className="section-heading">
              <h3>
                {full || !parent
                  ? 'Snapshot contents'
                  : 'Changes from previous version'}
              </h3>
              <div
                className="actions"
                role="group"
                aria-label="Content display"
              >
                <button
                  className="quiet-button"
                  disabled={!parent}
                  aria-pressed={!full}
                  onClick={() => replaceRouteSelection({ content: undefined })}
                >
                  Changes
                </button>
                <button
                  className="quiet-button"
                  aria-pressed={full}
                  onClick={() => replaceRouteSelection({ content: 'full' })}
                >
                  Full contents
                </button>
              </div>
            </div>
            {!full && parent ? (
              <CandidateTextDiff
                id={id}
                parent={parent}
                current={record.resourceRef}
                prefix={prefix}
              />
            ) : (
              <Snapshot id={id} artifact={record.resourceRef} prefix={prefix} />
            )}
          </>
        ) : (
          <p className="empty-state">
            {record.inProgress
              ? 'Memory update is in progress.'
              : 'No resource snapshot was recorded.'}
          </p>
        )}
        {record.callId ? (
          <a
            className="text-link"
            href={route(id, 'calls', undefined, undefined, {
              call: record.callId,
            })}
          >
            View call
          </a>
        ) : null}
      </div>
      {record.resourceRef ? (
        <ApplySnapshot
          id={id}
          revision={record.id}
          collection={memory ? 'memories' : 'revisions'}
          label={`${title(record)} · ${bindingLabel(record)}`}
        />
      ) : null}
    </Card>
  );
}

export function Evolution({
  id,
  finished,
}: {
  id: string;
  finished: boolean;
}): React.JSX.Element {
  const selection = useRoute();
  const memory = selection.evolution === 'memory';
  const records = useObservation(
    `/${encodeURIComponent(id)}/${memory ? 'memories' : 'revisions'}`,
    parseEvolution,
    finished ? null : 10000,
  );
  const items = records.data ?? [];
  const selected = selection.revision
    ? items.find((item) => item.id === selection.revision)
    : items[0];
  const reset = {
    revision: undefined,
    file: undefined,
    diffFile: undefined,
    content: undefined,
  };
  return (
    <section className="section-stack" aria-label="Reflection and Memory">
      <div className="section-heading">
        <div className="actions" role="group" aria-label="Evolution records">
          <button
            className="quiet-button"
            aria-pressed={!memory}
            onClick={() =>
              replaceRouteSelection({ ...reset, evolution: undefined })
            }
          >
            Reflection
          </button>
          <button
            className="quiet-button"
            aria-pressed={memory}
            onClick={() =>
              replaceRouteSelection({ ...reset, evolution: 'memory' })
            }
          >
            Memory
          </button>
        </div>
        <button className="quiet-button" onClick={records.refresh}>
          Refresh
        </button>
      </div>
      <Feedback {...records} />
      {records.data && !items.length ? (
        <Card>
          <div className="empty-state">
            {memory
              ? 'No Memory records found.'
              : 'No Reflection revisions recorded.'}
          </div>
        </Card>
      ) : null}
      {items.length ? (
        <div className="evolution-workspace">
          <nav
            className="evolution-records"
            aria-label={memory ? 'Memory history' : 'Reflection revisions'}
          >
            {items.map((item) => (
              <a
                key={item.id}
                className="evolution-record"
                aria-current={selected?.id === item.id ? 'true' : undefined}
                href={route(id, 'evolution', undefined, undefined, {
                  evolution: memory ? 'memory' : undefined,
                  revision: item.id,
                })}
              >
                <div className="evolution-record-heading">
                  <strong>{title(item)}</strong>
                  {item.kind !== 'initial' && roundLabel(item.path) ? (
                    <span className="call-round">{roundLabel(item.path)}</span>
                  ) : null}
                </div>
                <span>{bindingLabel(item)}</span>
                {memory ? (
                  <span className="muted">
                    {item.status} · <Timestamp value={item.startedAt} />
                  </span>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="evolution-detail">
            {selected ? (
              <Detail
                key={`${id}:${selected.id}`}
                id={id}
                record={selected}
                memory={memory}
              />
            ) : (
              <p className="filter-note">
                The selected record is unavailable. Choose another version from
                the list.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
