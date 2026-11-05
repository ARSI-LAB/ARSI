import React, { useEffect, useRef, useState } from 'react';
import {
  parseLearning,
  parseApplication,
  applyRevision,
  type LearningRecord,
} from '../../api/learning-client';
import { parseArtifact } from '../../api/observation-client';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { route } from '../../app/routing';
import { Feedback, Timestamp } from '../../components/observation-feedback';
import { Card } from '../../components/ui/card';
import { useObservation, useAllObservations } from './use-observation';
import { CandidateTextDiff } from './candidate-text-diff';
import { parseArtifactFiles } from './file-browser-model';
import { roundLabel } from './round-label-model';

function revisionDepth(
  record: LearningRecord,
  records: LearningRecord[],
): number {
  const visited = new Set<string>();
  let current: LearningRecord | undefined = record;
  let depth = 0;
  while (current?.parentRef && !visited.has(current.id)) {
    visited.add(current.id);
    depth++;
    current = records.find((item) => item.id === current?.parentRef);
  }
  return depth;
}
function title(record: LearningRecord, records: LearningRecord[]): string {
  if (record.kind === 'memory')
    return roundLabel(record.path) ?? 'Memory update';
  return record.kind === 'initial'
    ? 'Initial version'
    : `Revision ${revisionDepth(record, records)}`;
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
        <label className="learning-field">
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

function ApplyRevision({
  id,
  revision,
  label,
}: {
  id: string;
  revision: string;
  label: string;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
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
  const preview = useObservation(
    open
      ? `/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/application?inspection=${inspection}`
      : null,
    parseApplication,
    null,
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
      const status = await applyRevision(id, revision);
      if (mounted.current) {
        setResult(
          status === 'applied'
            ? 'Source files updated.'
            : 'Source files already match this version.',
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
    <div className="learning-apply">
      <div className="section-heading">
        <p className="muted">
          Apply this version to its original source files for future
          experiments.
        </p>
        <button
          ref={trigger}
          className="quiet-button learning-primary"
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
        <p role="status" className="learning-success">
          {result}
        </p>
      ) : null}
      <dialog
        ref={dialog}
        className="learning-dialog"
        aria-labelledby="learning-apply-title"
        aria-describedby="learning-apply-description"
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
          <h2 id="learning-apply-title">Apply to source files</h2>
          <button
            className="quiet-button"
            disabled={pending}
            onClick={close}
            aria-label="Close application preview"
          >
            ×
          </button>
        </div>
        <p id="learning-apply-description" className="muted">
          Selected snapshot: {label}.
        </p>
        <Feedback {...preview} />
        {preview.data && !preview.error ? (
          <>
            {!preview.data.applicationAllowed ? (
              <section
                className="learning-blocked"
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
              <div className="learning-apply-summary">
                <h3>Files to update</h3>
                <p className="muted">
                  Local edits in these paths will be replaced by the saved
                  snapshot. Removed entries will be deleted.
                </p>
              </div>
            ) : null}
            <ul className="learning-plan">
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
              <p>Source files already match this version.</p>
            ) : null}
            {preview.data.applicationAllowed && preview.data.changes.length ? (
              <label className="learning-ack">
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
              className="quiet-button learning-primary"
              disabled={
                pending || attempted || !acknowledged || !!preview.error
              }
              onClick={() => void apply()}
            >
              {pending ? 'Applying…' : 'Apply changes'}
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
  records,
  memory,
}: {
  id: string;
  record: LearningRecord;
  records: LearningRecord[];
  memory: boolean;
}): React.JSX.Element {
  const selection = useRoute();
  const full = selection.content === 'full';
  const parent = memory
    ? record.parentRef
    : records.find((item) => item.id === record.parentRef)?.resourceRef;
  const prefix = memory ? '' : `bindings/${record.binding}/resources/`;
  return (
    <Card>
      <div className="ui-card-header">
        <div className="section-heading">
          <h2>{title(record, records)}</h2>
          <span className="status-badge">
            {memory
              ? record.status
              : record.kind === 'initial'
                ? 'Initial'
                : 'Generated'}
          </span>
        </div>
        <p className="muted">
          {record.binding}
          {!memory && record.kind !== 'initial' && roundLabel(record.path)
            ? ` · Triggered after ${roundLabel(record.path)}`
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
          <div className="learning-reason">
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
            {record.status === 'running'
              ? 'Memory update is in progress.'
              : 'No resource snapshot was recorded.'}
          </p>
        )}
        {memory ? (
          <a
            className="text-link"
            href={route(id, 'calls', undefined, undefined, { call: record.id })}
          >
            View call
          </a>
        ) : null}
      </div>
      {!memory ? (
        <ApplyRevision
          id={id}
          revision={record.id}
          label={`${title(record, records)} · ${record.binding}`}
        />
      ) : null}
    </Card>
  );
}

export function Learning({
  id,
  finished,
}: {
  id: string;
  finished: boolean;
}): React.JSX.Element {
  const selection = useRoute();
  const memory = selection.learning === 'memory';
  const records = useObservation(
    `/${encodeURIComponent(id)}/${memory ? 'memories' : 'revisions'}`,
    parseLearning,
    finished ? null : 10000,
  );
  const items = [...(records.data ?? [])].sort((a, b) =>
    memory
      ? (b.startedAt ?? '').localeCompare(a.startedAt ?? '')
      : a.binding.localeCompare(b.binding) ||
        revisionDepth(b, records.data ?? []) -
          revisionDepth(a, records.data ?? []),
  );
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
        <div className="actions" role="group" aria-label="Learning records">
          <button
            className="quiet-button"
            aria-pressed={!memory}
            onClick={() =>
              replaceRouteSelection({ ...reset, learning: undefined })
            }
          >
            Reflection
          </button>
          <button
            className="quiet-button"
            aria-pressed={memory}
            onClick={() =>
              replaceRouteSelection({ ...reset, learning: 'memory' })
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
              ? 'No Memory calls recorded.'
              : 'No Reflection revisions recorded.'}
          </div>
        </Card>
      ) : null}
      {items.length ? (
        <div className="learning-workspace">
          <nav
            className="learning-records"
            aria-label={memory ? 'Memory history' : 'Reflection revisions'}
          >
            {items.map((item) => (
              <a
                key={item.id}
                className="learning-record"
                aria-current={selected?.id === item.id ? 'true' : undefined}
                href={route(id, 'learning', undefined, undefined, {
                  learning: memory ? 'memory' : undefined,
                  revision: item.id,
                })}
              >
                <div className="learning-record-heading">
                  <strong>{title(item, items)}</strong>
                  {!memory &&
                  item.kind !== 'initial' &&
                  roundLabel(item.path) ? (
                    <span className="call-round">
                      {roundLabel(item.path)?.replace(/Round /g, 'R')}
                    </span>
                  ) : null}
                </div>
                <span>{item.binding}</span>
                {memory ? (
                  <span className="muted">
                    {item.status} · <Timestamp value={item.startedAt} />
                  </span>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="learning-detail">
            {selected ? (
              <Detail
                key={`${id}:${selected.id}`}
                id={id}
                record={selected}
                records={items}
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
