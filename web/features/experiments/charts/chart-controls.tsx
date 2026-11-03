import React from 'react';
export const format = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 4 });
export function QueryNotice({
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
          Loading all recorded observations…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="error-notice">
          {error} Previously loaded charts may be stale.
          <button className="quiet-button" onClick={refresh}>
            Retry charts
          </button>
        </div>
      ) : null}
    </>
  );
}
export function WindowControls({
  offset,
  length,
  size,
  setOffset,
}: {
  offset: number;
  length: number;
  size: number;
  setOffset: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="pagination">
      <span>
        {length
          ? `${offset + 1}–${Math.min(offset + size, length)} of ${length} observations`
          : '0 observations'}
      </span>
      <div className="actions">
        <button
          className="quiet-button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - size))}
        >
          Previous observations
        </button>
        <button
          className="quiet-button"
          disabled={offset + size >= length}
          onClick={() => setOffset(offset + size)}
        >
          Next observations
        </button>
      </div>
    </div>
  );
}
