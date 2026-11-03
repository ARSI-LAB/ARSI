import React from 'react';
import type { JsonPreview, Page } from '../api/observation-client';
export function Status({ value }: { value: string }): React.JSX.Element {
  return (
    <span className="status-badge" data-status={value}>
      {value}
    </span>
  );
}
export function Timestamp({
  value,
}: {
  value: string | null;
}): React.JSX.Element {
  return (
    <time dateTime={value ?? undefined}>
      {value ? new Date(value).toLocaleString() : 'Not recorded'}
    </time>
  );
}
export function Preview({
  label,
  value,
}: {
  label: string;
  value: JsonPreview | null;
}): React.JSX.Element {
  return (
    <section className="json-preview" aria-label={label}>
      <h4>
        {label}
        {value?.truncated ? ' · truncated preview' : ''}
      </h4>
      <pre tabIndex={0}>{value?.text ?? 'Not recorded'}</pre>
    </section>
  );
}
export function Feedback({
  loading,
  error,
  refresh,
}: {
  loading: boolean;
  error: string;
  refresh: () => void;
}): React.JSX.Element {
  return (
    <>
      {loading ? (
        <p role="status" className="empty-state">
          Loading recorded facts…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="error-notice">
          <span>{error} · Displayed data may be stale.</span>
          <button className="quiet-button" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
export function Pagination({
  page,
  offset,
  setOffset,
}: {
  page: Page<unknown>;
  offset: number;
  setOffset: (value: number) => void;
}): React.JSX.Element {
  if (offset === 0 && page.nextOffset === null)
    return (
      <p className="muted">
        {page.total} {page.total === 1 ? 'record' : 'records'}
      </p>
    );
  return (
    <div className="pagination">
      <span>
        {page.total === 0
          ? '0 records'
          : `${offset + 1}–${offset + page.items.length} of ${page.total}`}
      </span>
      <div className="actions">
        <button
          className="quiet-button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous
        </button>
        <button
          className="quiet-button"
          disabled={page.nextOffset === null}
          onClick={() => {
            if (page.nextOffset !== null) setOffset(page.nextOffset);
          }}
        >
          Next
        </button>
      </div>
    </div>
  );
}
