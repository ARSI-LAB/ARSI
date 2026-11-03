import React, { useEffect, useRef, useState } from 'react';
import { parseArtifact, type JsonPreview } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import { Feedback, Pagination } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import {
  fileEntries,
  parentDirectory,
  parseArtifactFiles,
} from './file-browser-model';
import { useAllObservations, useObservation } from './use-observation';

function CodePreview({
  value,
  label,
}: {
  value: JsonPreview | null;
  label: string;
}): React.JSX.Element {
  const [wrap, setWrap] = useState(false);
  const text = value?.text ?? '';
  const lines = text.split('\n').length;
  return (
    <div className="section-stack">
      <div className="section-heading">
        <span className="muted">
          {value
            ? `${lines.toLocaleString()} preview lines`
            : 'No text recorded'}
        </span>
        <label className="wrap-control">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
          />
          Wrap lines
        </label>
      </div>
      {value?.truncated ? (
        <p role="status" className="filter-note">
          This preview is truncated to 32,768 characters. It is not the complete
          file.
        </p>
      ) : null}
      <div
        className="code-scroll"
        data-wrap={wrap}
        role="region"
        tabIndex={0}
        aria-label={`${label} text preview`}
      >
        {!wrap && lines <= 5000 && value ? (
          <pre className="code-line-numbers" aria-hidden="true">
            {Array.from({ length: lines }, (_, index) => index + 1).join('\n')}
          </pre>
        ) : null}
        <pre className="code-content">{value?.text ?? 'Not recorded'}</pre>
      </div>
    </div>
  );
}

export function ArtifactBrowser({
  id,
  artifact,
  candidate,
  file,
  directory,
}: {
  id: string;
  artifact: string;
  candidate?: string;
  file?: string;
  directory?: string;
}): React.JSX.Element {
  const base = `/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact)}`;
  const metadata = useObservation(base, parseArtifact, null);
  const index = useAllObservations(
    metadata.data?.kind === 'file-tree' ? base : null,
    parseArtifactFiles,
    null,
  );
  const content = useObservation(
    metadata.data?.kind === 'file-tree' && file
      ? `${base}?${new URLSearchParams({ path: file })}`
      : null,
    parseArtifact,
    null,
  );
  const preview = useRef<HTMLElement>(null);
  const kind = metadata.data?.kind;
  useEffect(() => {
    if (file && kind === 'file-tree') {
      preview.current?.focus({ preventScroll: true });
      preview.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [file, kind]);
  const currentDirectory = directory ?? (file ? parentDirectory(file) : '');
  const location = useRoute();
  const search = location.fileSearch ?? '';
  const [page, setPage] = useState({ key: '', offset: 0 });
  const pageKey = JSON.stringify([currentDirectory, search]);
  const entries = fileEntries(
    index.data?.items ?? [],
    currentDirectory,
    search,
  );
  const offset =
    page.key === pageKey && page.offset < entries.length ? page.offset : 0;
  const visible = entries.slice(offset, offset + 50);
  const href = (selection: { file?: string; directory?: string }): string =>
    route(id, 'candidates', candidate, artifact, {
      ...selection,
      content: 'files',
      search: location.search,
      fileSearch: search,
      diffFile: location.diffFile,
    });
  return (
    <Card>
      <CardHeader>
        <h2>Candidate files</h2>
      </CardHeader>
      <CardContent>
        <Feedback {...metadata} />
        {metadata.data ? (
          metadata.data.kind === 'file-tree' ? (
            <div className="file-browser-workspace">
              <aside
                className="file-browser-sidebar"
                aria-label="Recorded file browser"
              >
                <h3>Files</h3>
                <label className="browser-search">
                  Search all recorded paths
                  <input
                    type="search"
                    placeholder="Filename or full path"
                    value={search}
                    onChange={(event) =>
                      replaceRouteSelection({ fileSearch: event.target.value })
                    }
                  />
                </label>
                <Feedback {...index} />
                <nav
                  className="file-breadcrumbs"
                  aria-label="Artifact directory"
                >
                  <a className="text-link" href={href({})}>
                    Root
                  </a>
                  {currentDirectory
                    .split('/')
                    .filter(Boolean)
                    .map((part, i, parts) => (
                      <React.Fragment key={parts.slice(0, i + 1).join('/')}>
                        <span aria-hidden="true">/</span>
                        <a
                          className="text-link"
                          href={href({
                            directory: parts.slice(0, i + 1).join('/'),
                          })}
                        >
                          {part}
                        </a>
                      </React.Fragment>
                    ))}
                </nav>
                {currentDirectory ? (
                  <a
                    className="quiet-button file-up"
                    href={href({
                      directory: parentDirectory(currentDirectory),
                    })}
                  >
                    ↑ Parent directory
                  </a>
                ) : null}
                {index.data ? (
                  <>
                    <p className="muted">
                      {search.trim()
                        ? `${entries.length} matching ${entries.length === 1 ? 'file' : 'files'} across the artifact`
                        : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} in this directory`}{' '}
                      · {index.data.total} files indexed
                    </p>
                    <ul className="file-browser-entries">
                      {visible.map((entry) => (
                        <li key={entry.path}>
                          <a
                            className="file-browser-entry"
                            data-kind={entry.kind}
                            aria-current={
                              file === entry.path && entry.kind === 'file'
                                ? 'true'
                                : undefined
                            }
                            href={
                              entry.kind === 'directory'
                                ? href({ directory: entry.path })
                                : href({
                                    file: entry.path,
                                    directory: parentDirectory(entry.path),
                                  })
                            }
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="18"
                              height="18"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            >
                              {entry.kind === 'directory' ? (
                                <path d="M3 6h7l2 3h9v11H3z" />
                              ) : (
                                <>
                                  <path d="M5 3h9l5 5v13H5z" />
                                  <path d="M14 3v6h5" />
                                </>
                              )}
                            </svg>
                            <span>
                              <strong>{entry.name}</strong>
                              <small>
                                {entry.kind === 'directory'
                                  ? `${entry.files} ${entry.files === 1 ? 'file' : 'files'}`
                                  : `${entry.bytes.toLocaleString()} bytes`}
                              </small>
                            </span>
                            {entry.kind === 'directory' ? (
                              <span aria-hidden="true">›</span>
                            ) : null}
                          </a>
                        </li>
                      ))}
                    </ul>
                    {!entries.length ? (
                      <p className="empty-state">
                        {search.trim()
                          ? 'No files match this search.'
                          : currentDirectory
                            ? 'No recorded entries at this directory path.'
                            : 'No files recorded in this artifact.'}
                      </p>
                    ) : null}
                    <Pagination
                      page={{
                        items: visible,
                        total: entries.length,
                        nextOffset:
                          offset + 50 < entries.length ? offset + 50 : null,
                      }}
                      offset={offset}
                      setOffset={(value) =>
                        setPage({ key: pageKey, offset: value })
                      }
                    />
                  </>
                ) : null}
              </aside>
              <section
                className="file-browser-preview"
                ref={preview}
                tabIndex={-1}
                aria-label="Selected file preview"
              >
                <div className="section-heading">
                  <h3>{file ?? 'Select a file'}</h3>
                  {file ? (
                    <a
                      className="text-link"
                      href={href({ file, directory: currentDirectory })}
                    >
                      Link to file
                    </a>
                  ) : null}
                </div>
                {file ? (
                  <>
                    <Feedback {...content} />
                    {content.data ? (
                      content.data.unavailable ? (
                        <p className="empty-state">
                          {content.data.unavailable}
                        </p>
                      ) : (
                        <CodePreview
                          key={file}
                          value={content.data.content}
                          label={file}
                        />
                      )
                    ) : null}
                  </>
                ) : (
                  <p className="empty-state">
                    Open a directory or search the recorded paths, then select a
                    file to read its content.
                  </p>
                )}
              </section>
            </div>
          ) : (
            <>
              {file ? (
                <p className="filter-note">
                  This artifact contains JSON rather than a file tree.{' '}
                  <a className="text-link" href={href({})}>
                    Clear file selection
                  </a>
                </p>
              ) : null}
              <CodePreview
                value={metadata.data.content}
                label="Artifact JSON"
              />
            </>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
