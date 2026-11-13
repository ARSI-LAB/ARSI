import {
  connectionSnapshot,
  subscribeConnection,
  retryConnection,
  subscribeRetry,
} from '../api/connection-state';
import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { readObservationSource } from '../api/observation-client';
import emberRsiLogo from '../../docs/users/assets/ember-rsi-logo.png';
import { useRoute } from './use-route';
import { viewRoute } from './view-memory';

export function WorkspaceLayout({
  children,
  routeKey,
  isList,
}: {
  children: React.ReactNode;
  routeKey: string;
  isList: boolean;
}): React.JSX.Element {
  const navigation = useRoute();
  const disconnected = useSyncExternalStore(
    subscribeConnection,
    connectionSnapshot,
  );
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeNavigation = (): void => {
    setSidebarOpen(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = (): void => {
      setNarrow(media.matches);
      setSidebarOpen(!media.matches);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [narrow, sidebarOpen]);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeRetry(() => setRevision((value) => value + 1)), []);
  const main = useRef<HTMLElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    readObservationSource(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setSource(value.directory);
      },
      () => {
        if (!controller.signal.aborted) setSourceError(true);
      },
    );
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    main.current?.focus();
  }, [routeKey]);
  return (
    <div className={`studio-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <aside
        ref={sidebar}
        role={narrow && sidebarOpen ? 'dialog' : undefined}
        aria-modal={narrow && sidebarOpen ? true : undefined}
        aria-label="Workspace navigation"
        onKeyDown={(event) => {
          if (!narrow) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            closeNavigation();
          }
          if (event.key === 'Tab') {
            const items =
              sidebar.current?.querySelectorAll<HTMLElement>('button, a[href]');
            const first = items?.[0],
              last = items?.[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        onClick={(event) => {
          if (narrow && (event.target as HTMLElement).closest('a'))
            setSidebarOpen(false);
        }}
        id="workspace-navigation"
        className={`studio-sidebar ${sidebarOpen ? 'is-open' : ''}`}
      >
        {narrow ? (
          <button
            className="studio-sidebar-close quiet-button"
            aria-label="Close sidebar"
            onClick={closeNavigation}
          >
            ×
          </button>
        ) : null}
        <a href="#" className="studio-brand">
          <img src={emberRsiLogo} className="brand-mark" alt="ember-rsi" />
        </a>
        <nav className="studio-nav" aria-label="Workspace">
          <span className="nav-caption">Workspace</span>
          <a
            href="#"
            className={isList ? 'active' : undefined}
            aria-current={isList ? 'page' : undefined}
          >
            Experiments
          </a>
        </nav>
        {navigation.id ? (
          <nav
            className="studio-nav experiment-sidebar-nav"
            aria-label="Current experiment"
          >
            <span className="nav-caption">Experiment analysis</span>
            {(
              [
                ['overview', 'Overview'],
                ['results', 'Performance & results'],
                ['candidates', 'Candidates'],
                ['measurements', 'Measurements'],
                ['learning', 'Reflection & Memory'],
                ['calls', 'Call history'],
                ['policy', 'Policy'],
                ['recipe', 'Recipe'],
              ] as const
            ).map(([view, label]) => (
              <a
                key={view}
                href={viewRoute(navigation.id!, view)}
                aria-current={navigation.view === view ? 'page' : undefined}
                className={navigation.view === view ? 'active' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
        ) : null}
        <div className="studio-sidebar-footer">
          <span className="studio-record-dot" /> Recorded experiment data
          <p>Ember RSI · Experiment lab</p>
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          className="studio-sidebar-scrim"
          aria-label="Close navigation"
          onClick={closeNavigation}
        />
      ) : null}
      <div className="studio-workspace" inert={narrow && sidebarOpen}>
        <header className="studio-topbar">
          <button
            ref={toggle}
            className="sidebar-toggle"
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="workspace-navigation"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <a href="#" className="breadcrumbs">
            RSI / Experiments
          </a>
          <details className="workspace-source">
            <summary>Data source</summary>
            <code>
              {source ?? (sourceError ? 'Unavailable' : 'Not provided')}
            </code>
          </details>
        </header>
        <main id="main" ref={main} tabIndex={-1} className="studio-main">
          {disconnected ? (
            <div className="error-notice connection-notice" role="alert">
              <span>Connection lost. Displayed data may be stale.</span>
              <button className="quiet-button" onClick={retryConnection}>
                Retry
              </button>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
