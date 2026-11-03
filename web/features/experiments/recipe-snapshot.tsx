import React from 'react';
import type { JsonPreview } from '../../api/observation-client';

export function RecipeSnapshot({
  value,
}: {
  value: JsonPreview | null;
}): React.JSX.Element {
  if (!value)
    return <p className="empty-state">No recipe snapshot was recorded.</p>;
  return (
    <div className="section-stack">
      {value.truncated ? (
        <p className="filter-note" role="status">
          This saved JSON preview is truncated.
        </p>
      ) : null}
      <pre
        className="content-text recipe-source"
        tabIndex={0}
        aria-label="Saved recipe JSON"
      >
        <code>{value.text}</code>
      </pre>
    </div>
  );
}
